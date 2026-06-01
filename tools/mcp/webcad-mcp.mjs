#!/usr/bin/env node
// webcad-mcp.mjs — MCP stdio server bridging to the running WEB-CAD browser page
//
// Architecture: AI client (Claude) ↔ this MCP server (stdio) ↔ CDP :9222 ↔ WEB-CAD page ↔ dispatch()
//
// The browser page must expose window.__wcDispatch (added in web/src/main.ts) for geometry ops.
// Page.captureScreenshot used for viewport images.
//
// Browser lock protocol:
//   dispatch/list/schema tools: NO lock — pure JS eval, no cursor/focus steal
//   get_viewport_image:         Needs lock — Page.captureScreenshot captures user-visible frame
//
// Safety: Archie has :9222 priority for cold-cache passes. Yield on conflicts.

import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const YAML_PATH = join(__dir, '../../web/src/commands/spatial-api.yaml');
const SCREENSHOT_DIR = join(__dir, '../../state/mcp-screenshots');
const CDP_URL = 'http://localhost:9222';

// ---------------------------------------------------------------------------
// YAML parser — minimal, covers spatial-api.yaml structure
// ---------------------------------------------------------------------------

function parseYaml(src) {
  const lines = src.split('\n');
  const verbs = [];
  let cur = null;
  let inParams = false;
  let paramLines = [];
  let depth = 0;
  let currentCategory = '';

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Section header comment: # ===...=== followed by # §N Title or # §N Title on same/next line
    if (trimmed.startsWith('#')) {
      const sectionMatch = trimmed.match(/^#\s*§\d+\s+(.+)/);
      if (sectionMatch) currentCategory = sectionMatch[1].trim();
      continue;
    }

    if (!trimmed) continue;

    const indent = raw.match(/^(\s*)/)[1].length;

    // Top-level verb entry
    if (indent === 0 && trimmed.startsWith('- name:')) {
      if (cur) { cur.paramRaw = paramLines.join('\n'); verbs.push(cur); }
      cur = {
        name: trimmed.replace('- name:', '').trim().replace(/['"]/g, ''),
        kernel_op: '', category: currentCategory, synonyms: [], description: '',
        topology_role: '', returns: null, paramRaw: '',
      };
      inParams = false;
      paramLines = [];
      continue;
    }

    if (!cur) continue;

    if (trimmed.startsWith('kernel_op:'))   { cur.kernel_op    = trimmed.split(':')[1].trim().replace(/['"]/g, ''); continue; }
    if (trimmed.startsWith('description:')) { cur.description  = trimmed.split(':')[1].trim().replace(/['"]/g, ''); continue; }
    if (trimmed.startsWith('topology_role:')){ cur.topology_role = trimmed.split(':')[1].trim().replace(/['"]/g, ''); continue; }

    if (trimmed.startsWith('synonyms:')) {
      const inline = trimmed.match(/synonyms:\s*\[([^\]]*)\]/);
      if (inline) {
        cur.synonyms = inline[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
      }
      // block-form synonyms handled below
      continue;
    }
    // Block-form synonym list item
    if (indent >= 2 && trimmed.startsWith('- ') && i > 0 && lines[i-1].trim().startsWith('synonyms:')) {
      cur.synonyms.push(trimmed.slice(2).replace(/['"]/g, ''));
      continue;
    }

    if (trimmed.startsWith('parameters:')) { inParams = true; depth = indent; paramLines = []; continue; }
    if (trimmed.startsWith('returns:'))    { inParams = false; cur.returns = trimmed.split(':').slice(1).join(':').trim(); continue; }
    if (inParams) {
      // End of parameters block: a new top-level key at same indent as 'parameters:'
      if (indent <= depth && trimmed.match(/^[a-z_]+:/i) && !trimmed.startsWith('-')) {
        inParams = false;
      } else {
        paramLines.push(raw);
      }
    }
  }
  if (cur) { cur.paramRaw = paramLines.join('\n'); verbs.push(cur); }
  return verbs;
}

// Load verb catalog at startup
let VERBS = [];
let VERB_MAP = new Map();

try {
  const src = readFileSync(YAML_PATH, 'utf-8');
  VERBS = parseYaml(src);
  for (const v of VERBS) VERB_MAP.set(v.name, v);
  process.stderr.write(`webcad-mcp: loaded ${VERBS.length} verbs from spatial-api.yaml\n`);
} catch (e) {
  process.stderr.write(`webcad-mcp: WARN could not load spatial-api.yaml: ${e.message}\n`);
}

// ---------------------------------------------------------------------------
// CDP connection
// ---------------------------------------------------------------------------

let _ws = null;
let _cdpId = 1;
const _cdpPending = new Map();

async function cdpConnect() {
  if (_ws && _ws.readyState === 1) return _ws; // already open

  // Get the WEB-CAD page WebSocket URL from /json/list
  const listResp = await fetch(`${CDP_URL}/json/list`).catch(e => {
    throw new Error(`WEB-CAD not running — could not reach ${CDP_URL}/json/list: ${e.message}`);
  });
  if (!listResp.ok) throw new Error(`CDP /json/list returned ${listResp.status}`);
  const tabs = await listResp.json();

  // Find the WEB-CAD page (prefer page type, prefer URL containing WEB-CAD)
  const tab = tabs.find(t => t.type === 'page' && (t.url?.includes('WEB-CAD') || t.url?.includes('localhost') || t.url?.includes('127.0.0.1')))
           ?? tabs.find(t => t.type === 'page');
  if (!tab) throw new Error('WEB-CAD not running — no page tab found at :9222');
  const wsUrl = tab.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error('WEB-CAD page has no WebSocket debugger URL');

  process.stderr.write(`webcad-mcp: connecting CDP → ${wsUrl}\n`);

  // Native WebSocket available in Node 22+; fall back to ws package if needed
  const Ws = globalThis.WebSocket ?? (await import('ws').then(m => m.default).catch(() => null));
  if (!Ws) throw new Error('No WebSocket implementation — Node 22+ required or run: npm install ws');

  _ws = new Ws(wsUrl);
  await new Promise((res, rej) => {
    _ws.onopen = res;
    _ws.onerror = e => rej(new Error(`CDP WebSocket error: ${e.message ?? e}`));
  });

  _ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
    const pend = _cdpPending.get(msg.id);
    if (!pend) return;
    _cdpPending.delete(msg.id);
    clearTimeout(pend.timer);
    if (msg.error) pend.reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
    else pend.resolve(msg.result);
  };

  _ws.onerror = () => { _ws = null; };
  _ws.onclose = () => { _ws = null; };

  process.stderr.write('webcad-mcp: CDP connected\n');
  return _ws;
}

async function cdpSend(method, params = {}, timeoutMs = 15_000) {
  const ws = await cdpConnect();
  return new Promise((resolve, reject) => {
    const id = _cdpId++;
    const timer = setTimeout(() => {
      _cdpPending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, timeoutMs);
    _cdpPending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function handleCall(toolName, args) {
  switch (toolName) {

    case 'dispatch': {
      const { verb, args: verbArgs = {} } = args;
      if (!verb) throw new Error('dispatch: verb is required');

      // Call window.__wcDispatch via CDP Runtime.evaluate
      const expr = `(async () => {
        if (typeof window.__wcDispatch !== 'function')
          return JSON.stringify({ok:false,error:'__wcDispatch not found — page may be loading or needs rebuild'});
        return await window.__wcDispatch(${JSON.stringify(verb)}, ${JSON.stringify(verbArgs)});
      })()`;

      const result = await cdpSend('Runtime.evaluate', {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
        timeout: 30_000,
      });

      if (result?.exceptionDetails) {
        const ex = result.exceptionDetails;
        throw new Error(`CDP eval exception: ${ex.text ?? ex.exception?.description ?? JSON.stringify(ex)}`);
      }

      const raw = result?.result?.value;
      if (typeof raw !== 'string') throw new Error('dispatch returned non-string — page may be reloading');
      return JSON.parse(raw);
    }

    case 'list_verbs': {
      const { category } = args;
      const cats = [...new Set(VERBS.map(v => v.category).filter(Boolean))].sort();
      let filtered = VERBS;
      if (category) {
        const re = new RegExp(category, 'i');
        filtered = VERBS.filter(v => re.test(v.category) || re.test(v.name));
      }
      return {
        total: VERBS.length,
        shown: filtered.length,
        categories: category ? undefined : cats,
        verbs: filtered.map(v => ({
          name: v.name,
          category: v.category || undefined,
          description: v.description || undefined,
          synonyms: v.synonyms.length ? v.synonyms : undefined,
        })),
      };
    }

    case 'get_verb_schema': {
      const { verb } = args;
      if (!verb) throw new Error('get_verb_schema: verb is required');
      const entry = VERB_MAP.get(verb);
      if (!entry) {
        // Fuzzy: find closest by prefix or synonym
        const lower = verb.toLowerCase();
        const match = VERBS.find(v =>
          v.name.toLowerCase().startsWith(lower) ||
          v.synonyms.some(s => s.toLowerCase() === lower)
        );
        if (!match) throw new Error(`Verb not found: ${verb}. Use list_verbs to browse.`);
        return { canonical: match.name, note: `"${verb}" resolved to "${match.name}"`, ...schemaEntry(match) };
      }
      return schemaEntry(entry);
    }

    case 'get_viewport_image': {
      const { width = 1280, height = 720 } = args;
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      const ts = Date.now();
      const path = join(SCREENSHOT_DIR, `${ts}-viewport.png`);

      const result = await cdpSend('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: 0, width, height, scale: 1 },
      }, 20_000);

      if (!result?.data) throw new Error('Page.captureScreenshot returned no data');
      writeFileSync(path, Buffer.from(result.data, 'base64'));
      const estimated_tokens = Math.min(Math.round(width * height / 750), 1568);
      return { path, width, height, estimated_tokens };
    }

    case 'list_scene_objects': {
      // Use SdListObjects via dispatch
      const expr = `(async () => {
        if (typeof window.__wcDispatch !== 'function') return JSON.stringify({ok:false,error:'__wcDispatch not found'});
        return await window.__wcDispatch('SdListObjects', {});
      })()`;

      const result = await cdpSend('Runtime.evaluate', {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
        timeout: 15_000,
      });

      if (result?.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'eval exception');
      const raw = result?.result?.value;
      if (typeof raw !== 'string') throw new Error('list_scene_objects: non-string result');
      return JSON.parse(raw);
    }

    default:
      throw new Error(`unknown tool: ${toolName}`);
  }
}

function schemaEntry(entry) {
  return {
    name: entry.name,
    kernel_op: entry.kernel_op || undefined,
    category: entry.category || undefined,
    description: entry.description || undefined,
    topology_role: entry.topology_role || undefined,
    synonyms: entry.synonyms.length ? entry.synonyms : undefined,
    parameters_raw: entry.paramRaw.trim() || undefined,
    returns: entry.returns || undefined,
  };
}

// ---------------------------------------------------------------------------
// Tool catalog
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'dispatch',
    description: `Execute a WEB-CAD geometry verb via the running browser page. Validates args against the spatial-api.yaml schema internally. Returns {ok, canonical, result?, error?}. Use list_verbs to browse the 323 available verbs; use get_verb_schema to check a verb's parameters before calling. Does NOT require the browser lock — pure JS eval, no cursor/focus.`,
    inputSchema: {
      type: 'object',
      properties: {
        verb: { type: 'string', description: 'Canonical verb name (e.g. "SdBox", "SdWall", "SdExtrude"). Synonyms are also resolved.' },
        args: { type: 'object', description: 'Verb arguments matching the spatial-api.yaml parameter schema.', default: {} },
      },
      required: ['verb'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_verbs',
    description: `List available WEB-CAD geometry verbs (323 total across 13 categories: sketch, solid, edge/surface, transform, architectural, furniture, annotation, selection, view, analysis, IO, Grasshopper). Filter by category to reduce noise. Returns verb names + category + synonyms.`,
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Optional category filter (case-insensitive substring match on category or verb name). Examples: "architectural", "sketch", "transform", "analysis".' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_verb_schema',
    description: `Get the full spatial-api.yaml entry for a verb — parameter schema, returns, synonyms, kernel_op. Call this before dispatch to know what args a verb accepts.`,
    inputSchema: {
      type: 'object',
      properties: {
        verb: { type: 'string', description: 'Canonical verb name or a synonym. Fuzzy-matched on prefix and synonyms.' },
      },
      required: ['verb'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_viewport_image',
    description: `Capture the current WEB-CAD viewport as a PNG. Saves to disk; returns path + estimated token cost. ⚠ Requires the browser lock (Page.captureScreenshot). Width/height default to 1280×720 (~1229 tokens).`,
    inputSchema: {
      type: 'object',
      properties: {
        width:  { type: 'number', default: 1280, description: 'Capture width in pixels (capped to page width)' },
        height: { type: 'number', default: 720,  description: 'Capture height in pixels' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_scene_objects',
    description: `List all objects currently in the WEB-CAD scene (calls SdListObjects). Returns UUIDs, names, types, and layer assignments. Does NOT require the browser lock.`,
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// MCP stdio JSON-RPC 2.0 server
// ---------------------------------------------------------------------------

const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

const rl = createInterface({ input: process.stdin });

rl.on('line', async line => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { error(null, -32700, 'Parse error'); return; }
  const { id, method, params } = req;
  if (id === undefined || id === null) return; // notification

  try {
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'webcad-mcp', version: '0.1.0' },
      });
    } else if (method === 'tools/list') {
      reply(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments ?? {};
      if (!toolName) { error(id, -32602, 'tools/call: name required'); return; }
      const result = await handleCall(toolName, toolArgs);
      reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } else {
      error(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    error(id, -32000, e.message ?? String(e));
  }
});

rl.on('close', () => {
  if (_ws) { try { _ws.close(); } catch {} }
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (_ws) { try { _ws.close(); } catch {} }
  process.exit(0);
});
