#!/usr/bin/env node
// webcad-mcp.mjs — MCP stdio server bridging to the running WEB-CAD browser page
//
// Architecture: AI client (Claude) ↔ this MCP server (stdio) ↔ CDP ↔ WEB-CAD page ↔ dispatch()
//
// DEFAULT (no slotId): connects to the user's :9222 Chromium, finds the WEB-CAD tab.
// SLOT MODE: spawns a DEDICATED Chromium (separate port + user-data-dir). Slots never touch
//   the user's :9222 window. The dedicated browser is non-headless — user can switch to it.
//
// Browser lock protocol:
//   dispatch / list / schema tools: NO lock — pure JS eval, no cursor/focus steal
//   get_viewport_image (no slotId): Needs lock — Page.captureScreenshot on user's :9222
//   get_viewport_image (with slotId): NO lock — dedicated browser, no shared state with user
//
// Slot lifecycle:
//   slot_create → dispatch/get_viewport_image (slotId) → slot_close
//   Dedicated browser launched lazily on first slot_create; killed when all slots close.

import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';

const __dir = dirname(fileURLToPath(import.meta.url));
const YAML_PATH = join(__dir, '../../web/src/commands/spatial-api.yaml');
const SCREENSHOT_DIR = join(__dir, '../../state/mcp-screenshots');
const DEFAULT_CDP = 'http://localhost:9222';
const WC_URL = 'https://wordingone.github.io/WEB-CAD/';

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

    if (trimmed.startsWith('#')) {
      const sectionMatch = trimmed.match(/^#\s*§\d+\s+(.+)/);
      if (sectionMatch) currentCategory = sectionMatch[1].trim();
      continue;
    }

    if (!trimmed) continue;

    const indent = raw.match(/^(\s*)/)[1].length;

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

    if (trimmed.startsWith('kernel_op:'))    { cur.kernel_op     = trimmed.split(':')[1].trim().replace(/['"]/g, ''); continue; }
    if (trimmed.startsWith('description:'))  { cur.description   = trimmed.split(':')[1].trim().replace(/['"]/g, ''); continue; }
    if (trimmed.startsWith('topology_role:')){ cur.topology_role  = trimmed.split(':')[1].trim().replace(/['"]/g, ''); continue; }

    if (trimmed.startsWith('synonyms:')) {
      const inline = trimmed.match(/synonyms:\s*\[([^\]]*)\]/);
      if (inline) cur.synonyms = inline[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
      continue;
    }
    if (indent >= 2 && trimmed.startsWith('- ') && i > 0 && lines[i-1].trim().startsWith('synonyms:')) {
      cur.synonyms.push(trimmed.slice(2).replace(/['"]/g, ''));
      continue;
    }

    if (trimmed.startsWith('parameters:')) { inParams = true; depth = indent; paramLines = []; continue; }
    if (trimmed.startsWith('returns:'))    { inParams = false; cur.returns = trimmed.split(':').slice(1).join(':').trim(); continue; }
    if (inParams) {
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
// CDP connection pool — keyed by WS URL
// ---------------------------------------------------------------------------

const _wsPool = new Map(); // wsUrl → { ws, nextId, pending }

async function getCdpWs(wsUrl) {
  if (_wsPool.has(wsUrl)) {
    const conn = _wsPool.get(wsUrl);
    if (conn.ws.readyState === 1) return conn;
    _wsPool.delete(wsUrl);
  }
  const Ws = globalThis.WebSocket ?? (await import('ws').then(m => m.default).catch(() => null));
  if (!Ws) throw new Error('No WebSocket implementation — Node 22+ required or npm install ws');
  const ws = new Ws(wsUrl);
  const conn = { ws, nextId: 1, pending: new Map() };
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = e => rej(new Error(`CDP WebSocket error: ${e.message ?? e}`));
  });
  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
    const pend = conn.pending.get(msg.id);
    if (!pend) return;
    conn.pending.delete(msg.id);
    clearTimeout(pend.timer);
    if (msg.error) pend.reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
    else pend.resolve(msg.result);
  };
  ws.onerror = () => _wsPool.delete(wsUrl);
  ws.onclose = () => _wsPool.delete(wsUrl);
  _wsPool.set(wsUrl, conn);
  return conn;
}

async function cdpCall(wsUrl, method, params = {}, timeoutMs = 15_000) {
  const conn = await getCdpWs(wsUrl);
  return new Promise((resolve, reject) => {
    const id = conn.nextId++;
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, timeoutMs);
    conn.pending.set(id, { resolve, reject, timer });
    conn.ws.send(JSON.stringify({ id, method, params }));
  });
}

// Get WS URL for the WEB-CAD page in the user's :9222 browser (default)
async function defaultWsUrl() {
  const listResp = await fetch(`${DEFAULT_CDP}/json/list`).catch(e => {
    throw new Error(`WEB-CAD not running — could not reach ${DEFAULT_CDP}/json/list: ${e.message}`);
  });
  if (!listResp.ok) throw new Error(`CDP /json/list returned ${listResp.status}`);
  const tabs = await listResp.json();
  const tab = tabs.find(t => t.type === 'page' && t.url?.includes('wordingone.github.io'))
           ?? tabs.find(t => t.type === 'page' && (t.url?.includes('localhost') || t.url?.includes('127.0.0.1')))
           ?? tabs.find(t => t.type === 'page');
  if (!tab) throw new Error('WEB-CAD not running — no page tab found at :9222');
  if (!tab.webSocketDebuggerUrl) throw new Error('WEB-CAD page has no WebSocket debugger URL');
  process.stderr.write(`webcad-mcp: connecting CDP → ${tab.webSocketDebuggerUrl}\n`);
  return tab.webSocketDebuggerUrl;
}

// Resolve WS URL: slot target if slotId given, default :9222 otherwise
async function resolveWsUrl(slotId) {
  if (!slotId) return defaultWsUrl();
  const slot = _slots.get(slotId);
  if (!slot) throw new Error(`Slot not found: ${slotId}. Use slot_list to see active slots.`);
  return slot.wsUrl;
}

// ---------------------------------------------------------------------------
// Dedicated browser management
// ---------------------------------------------------------------------------

let _dedicatedBrowser = null; // { proc, port, dir, browserWsUrl }
const _slots = new Map();      // slotId → { targetId, wsUrl, url }

function findChrome() {
  const user = process.env.USERNAME ?? process.env.USER ?? 'Admin';
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `C:/Users/${user}/AppData/Local/Google/Chrome/Application/chrome.exe`,
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    `C:/Users/${user}/AppData/Local/Microsoft/Edge/Application/msedge.exe`,
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`Chrome/Edge not found. Tried:\n  ${candidates.join('\n  ')}`);
}

async function findFreePort(start = 9223) {
  for (let p = start; p < 9300; p++) {
    const free = await new Promise(r => {
      const s = createServer();
      s.once('error', () => r(false));
      s.listen(p, () => s.close(() => r(true)));
    });
    if (free) return p;
  }
  throw new Error('No free CDP port found in range 9223–9299');
}

async function launchDedicatedBrowser() {
  if (_dedicatedBrowser) return _dedicatedBrowser;

  const port = await findFreePort();
  const dir = join(tmpdir(), `webcad-mcp-slots-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const chromePath = findChrome();

  process.stderr.write(`webcad-mcp: launching dedicated browser at :${port} (${chromePath.split('/').pop()})\n`);

  const proc = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--disable-translate',
    '--window-size=1280,800',
    'about:blank',
  ], { stdio: 'ignore' });

  proc.on('exit', () => {
    _dedicatedBrowser = null;
    for (const id of [..._slots.keys()]) _slots.delete(id);
    process.stderr.write('webcad-mcp: dedicated browser exited\n');
  });

  const maxMs = 25_000;
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`http://localhost:${port}/json/version`);
      if (r.ok) {
        const v = await r.json();
        _dedicatedBrowser = { proc, port, dir, browserWsUrl: v.webSocketDebuggerUrl };
        process.stderr.write(`webcad-mcp: dedicated browser ready at :${port}\n`);
        return _dedicatedBrowser;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 400));
  }
  proc.kill();
  throw new Error(`Dedicated browser did not start within ${maxMs}ms`);
}

async function waitForShim(wsUrl, maxMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await cdpCall(wsUrl, 'Runtime.evaluate', {
        expression: 'typeof window.__wcDispatch',
        returnByValue: true,
      }, 5_000);
      if (r?.result?.value === 'function') return;
    } catch {}
    await new Promise(r => setTimeout(r, 2_000));
  }
  throw new Error(`window.__wcDispatch not ready after ${maxMs}ms`);
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function handleCall(toolName, args) {
  switch (toolName) {

    case 'slot_create': {
      const { url } = args;
      const browser = await launchDedicatedBrowser();
      const slotId = `slot-${Date.now()}`;
      const targetUrl = url ?? `${WC_URL}?slot=${slotId}`;

      // Open a new tab in the dedicated browser via Target.createTarget
      const createResult = await cdpCall(browser.browserWsUrl, 'Target.createTarget', { url: targetUrl }, 15_000);
      const targetId = createResult.targetId;

      // Poll /json/list until the tab appears with its WS URL
      let wsUrl = null;
      for (let attempt = 0; attempt < 15; attempt++) {
        const listR = await fetch(`http://localhost:${browser.port}/json/list`);
        const tabs = await listR.json();
        const tab = tabs.find(t => t.id === targetId);
        if (tab?.webSocketDebuggerUrl) { wsUrl = tab.webSocketDebuggerUrl; break; }
        await new Promise(r => setTimeout(r, 500));
      }
      if (!wsUrl) throw new Error(`Slot tab WS URL not found for targetId=${targetId}`);

      process.stderr.write(`webcad-mcp: slot ${slotId} created — waiting for WEB-CAD boot...\n`);
      await waitForShim(wsUrl);
      process.stderr.write(`webcad-mcp: slot ${slotId} ready\n`);

      _slots.set(slotId, { targetId, wsUrl, url: targetUrl });
      return { slotId, targetId, url: targetUrl, cdpPort: browser.port };
    }

    case 'slot_list': {
      return {
        slots: [..._slots.entries()].map(([id, s]) => ({
          slotId: id,
          targetId: s.targetId,
          url: s.url,
        })),
        dedicatedBrowser: _dedicatedBrowser ? { port: _dedicatedBrowser.port, slots: _slots.size } : null,
      };
    }

    case 'slot_close': {
      const { slotId } = args;
      if (!slotId) throw new Error('slot_close: slotId required');
      const slot = _slots.get(slotId);
      if (!slot) throw new Error(`Slot not found: ${slotId}`);

      if (_dedicatedBrowser) {
        try {
          await cdpCall(_dedicatedBrowser.browserWsUrl, 'Target.closeTarget', { targetId: slot.targetId }, 5_000);
        } catch (e) {
          process.stderr.write(`webcad-mcp: slot_close warning: ${e.message}\n`);
        }
      }

      const conn = _wsPool.get(slot.wsUrl);
      if (conn) { try { conn.ws.close(); } catch {} _wsPool.delete(slot.wsUrl); }
      _slots.delete(slotId);

      if (_slots.size === 0 && _dedicatedBrowser) {
        process.stderr.write('webcad-mcp: all slots closed — killing dedicated browser\n');
        try { _dedicatedBrowser.proc.kill(); } catch {}
        _dedicatedBrowser = null;
      }

      return { closed: slotId, remainingSlots: _slots.size };
    }

    case 'dispatch': {
      const { verb, args: verbArgs = {}, slotId } = args;
      if (!verb) throw new Error('dispatch: verb is required');
      const wsUrl = await resolveWsUrl(slotId);

      const expr = `(async () => {
        if (typeof window.__wcDispatch !== 'function')
          return JSON.stringify({ok:false,error:'__wcDispatch not found — page may be loading or needs rebuild'});
        return await window.__wcDispatch(${JSON.stringify(verb)}, ${JSON.stringify(verbArgs)});
      })()`;

      const result = await cdpCall(wsUrl, 'Runtime.evaluate', {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
        timeout: 30_000,
      }, 35_000);

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
      const { width = 1280, height = 720, slotId } = args;
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      const wsUrl = await resolveWsUrl(slotId);
      const ts = Date.now();
      const label = slotId ? `slot-${slotId.slice(-6)}` : 'default';
      const path = join(SCREENSHOT_DIR, `${ts}-${label}-viewport.png`);

      const result = await cdpCall(wsUrl, 'Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: 0, width, height, scale: 1 },
      }, 20_000);

      if (!result?.data) throw new Error('Page.captureScreenshot returned no data');
      writeFileSync(path, Buffer.from(result.data, 'base64'));
      const estimated_tokens = Math.min(Math.round(width * height / 750), 1568);
      return { path, width, height, estimated_tokens, slotId: slotId ?? 'default' };
    }

    case 'list_scene_objects': {
      const { slotId } = args;
      const wsUrl = await resolveWsUrl(slotId);

      const expr = `(async () => {
        if (typeof window.__wcDispatch !== 'function') return JSON.stringify({ok:false,error:'__wcDispatch not found'});
        return await window.__wcDispatch('SdListObjects', {});
      })()`;

      const result = await cdpCall(wsUrl, 'Runtime.evaluate', {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
        timeout: 15_000,
      }, 20_000);

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
    name: 'slot_create',
    description: `Spawn a new WEB-CAD session in the dedicated slot browser (separate Chromium, separate profile — never touches the user's :9222 window). Returns slotId to pass to dispatch/get_viewport_image/list_scene_objects. The dedicated browser is launched lazily and stays alive until all slots are closed. WEB-CAD boots in the slot; slot_create returns after window.__wcDispatch is ready (~30-90s on first boot).`,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: `URL to open in the slot (default: ${WC_URL}?slot=<id>). Use this to pin a specific version or /dev surface.` },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'slot_list',
    description: `List all active WEB-CAD slots and the dedicated browser status.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'slot_close',
    description: `Close a WEB-CAD slot and free its browser tab. When the last slot closes, the dedicated browser is killed automatically.`,
    inputSchema: {
      type: 'object',
      properties: {
        slotId: { type: 'string', description: 'Slot ID returned by slot_create.' },
      },
      required: ['slotId'],
      additionalProperties: false,
    },
  },
  {
    name: 'dispatch',
    description: `Execute a WEB-CAD geometry verb. Returns {ok, canonical, result?, error?}. Use list_verbs to browse 323 verbs; use get_verb_schema to check parameters. Does NOT require the browser lock. Pass slotId to target a specific slot session; omit for the user's default :9222 WEB-CAD tab.`,
    inputSchema: {
      type: 'object',
      properties: {
        verb:   { type: 'string', description: 'Canonical verb name (e.g. "SdBox", "SdWall"). Synonyms resolved.' },
        args:   { type: 'object', description: 'Verb arguments per spatial-api.yaml schema.', default: {} },
        slotId: { type: 'string', description: 'Optional slot ID from slot_create. Omit for default :9222 tab.' },
      },
      required: ['verb'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_verbs',
    description: `List available WEB-CAD geometry verbs (323 total, 21 categories). Filter by category to reduce noise. Returns names + category + synonyms.`,
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Optional category filter (case-insensitive substring). E.g. "architectural", "sketch", "transform".' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_verb_schema',
    description: `Get the full spatial-api.yaml entry for a verb — parameter schema, returns, synonyms, kernel_op. Call before dispatch to know what args a verb accepts.`,
    inputSchema: {
      type: 'object',
      properties: {
        verb: { type: 'string', description: 'Canonical verb name or synonym. Fuzzy-matched on prefix and synonyms.' },
      },
      required: ['verb'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_viewport_image',
    description: `Capture the WEB-CAD viewport as a PNG. Saves to disk; returns path + estimated token cost (never base64 in response). ⚠ For the default :9222 tab: requires the browser lock (Page.captureScreenshot). For slot tabs: no lock needed (dedicated browser, isolated from user). Default 1280×720 ≈ 1229 tokens.`,
    inputSchema: {
      type: 'object',
      properties: {
        width:  { type: 'number', default: 1280, description: 'Capture width in pixels.' },
        height: { type: 'number', default: 720,  description: 'Capture height in pixels.' },
        slotId: { type: 'string', description: 'Optional slot ID. Omit for default :9222 tab (requires browser lock).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_scene_objects',
    description: `List all objects in the WEB-CAD scene (calls SdListObjects). Returns UUIDs, names, types, layer assignments. No browser lock required. Pass slotId for a specific slot.`,
    inputSchema: {
      type: 'object',
      properties: {
        slotId: { type: 'string', description: 'Optional slot ID. Omit for default :9222 tab.' },
      },
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
  if (id === undefined || id === null) return; // notification — no reply

  try {
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'webcad-mcp', version: '0.2.0' },
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

function cleanup() {
  for (const conn of _wsPool.values()) { try { conn.ws.close(); } catch {} }
  if (_dedicatedBrowser) { try { _dedicatedBrowser.proc.kill(); } catch {} }
  process.exit(0);
}

rl.on('close', cleanup);
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
