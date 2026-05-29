#!/usr/bin/env node
// Verifies the deployed /dev MODEL palette and FZK canonical BRep sample through
// the shared CDP browser. This is a warm-browser mechanism proof, not a cold-cache
// promotion gate.

import http from "node:http";
import https from "node:https";

const CDP_BASE = "http://127.0.0.1:9222";
const DEV_URL = "https://wordingone.github.io/WEB-CAD/dev/";
const expectedCommit = process.argv[2] ?? "";
let id = 0;

const SHARED_TOOLS = [
  "select", "move", "rotate", "scale", "copy", "array",
  "align-left", "align-center-h", "align-right", "align-top", "align-center-v", "align-bottom", "dist-h", "dist-v",
  "section", "clip",
  "aligned-dim", "angular-dim", "area-dim", "volume-dim", "label", "transient-measure",
];
const CAD_TOOLS = [
  "line", "rect", "circle", "polygon", "arc", "polyline", "curve", "spline", "point",
  "extrude", "loft", "sweep", "revolve", "plane", "surface",
  "boolean", "bool-union", "bool-diff", "bool-intersect", "fillet",
  "brep-explode", "brep-join", "brep-rebuild", "brep-contour",
];
const ARCH_TOOLS = [
  "wall", "slab", "column", "beam", "roof", "space", "foundation", "ceiling", "grid", "level", "datum",
  "stair", "door", "window", "ramp", "railing", "curtainwall", "skylight", "opening",
];
const EXPECTED_ARCH = [...SHARED_TOOLS.slice(0, 14), ...ARCH_TOOLS, ...SHARED_TOOLS.slice(14)];
const EXPECTED_CAD = [...SHARED_TOOLS.slice(0, 14), ...CAD_TOOLS, ...SHARED_TOOLS.slice(14)];

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(error); }
      });
    }).on("error", reject);
  });
}

function getText(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    client.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve(body.trim()));
    }).on("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function send(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 60_000);
    const onMessage = (raw) => {
      const msg = JSON.parse(String(raw?.data ?? raw));
      if (msg.id !== requestId) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
}

async function evaluate(ws, expression) {
  const result = await send(ws, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails, null, 2));
  return result.result.value;
}

function sameArray(a, b) {
  return Array.isArray(a) && a.length === b.length && a.every((value, index) => value === b[index]);
}

const deployedCommit = await getText(`${DEV_URL}COMMIT.txt?cache=${Date.now()}`);
if (expectedCommit && deployedCommit !== expectedCommit) {
  throw new Error(`deployed /dev commit ${deployedCommit} did not match expected ${expectedCommit}`);
}

const targets = await getJson(`${CDP_BASE}/json/list`);
const page = targets.find((target) => target.type === "page" && target.url.includes("WEB-CAD") && target.webSocketDebuggerUrl);
if (!page) throw new Error("WEB-CAD page target not found on shared CDP browser");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
await send(ws, "Runtime.enable");
await send(ws, "Page.enable");
await send(ws, "Page.navigate", {
  url: `${DEV_URL}?verify=model-palette-brep&commit=${deployedCommit.slice(0, 7)}&cache=${Date.now()}`,
});
await delay(6_000);

const palette = await evaluate(ws, `(() => {
  const modelSections = () => [...document.querySelectorAll(".palette-section")].slice(0, 8);
  const visibleModelButtons = () => modelSections().flatMap((section) =>
    section.classList.contains("palette-section--hidden") ? [] : [...section.querySelectorAll(".palette-btn[data-tool]")]
  );
  const visibleToolIds = () => visibleModelButtons().map((btn) => btn.dataset.tool).filter(Boolean);
  const activeModelTool = () => {
    const active = modelSections().flatMap((section) => [...section.querySelectorAll(".palette-btn.active[data-tool]")])[0];
    return active?.dataset?.tool ?? null;
  };
  const clickVisible = (tab) => {
    window.dispatchEvent(new CustomEvent("ribbon:section-tab", { detail: { tab } }));
    const ids = visibleToolIds();
    const clicks = [];
    for (const id of ids) {
      window.__dispatchSync?.("setActiveTool", { toolId: "select" });
      const btn = visibleModelButtons().find((candidate) => candidate.dataset.tool === id);
      btn?.click();
      const active = activeModelTool();
      clicks.push({ id, active, clicked: !!btn });
    }
    return { ids, clicks };
  };
  const arch = clickVisible("ARCH");
  const cad = clickVisible("CAD");
  const projectCards = [...document.querySelectorAll(".ribbon-asset-card[data-sample]")]
    .map((card) => ({ sample: card.dataset.sample, text: card.textContent?.trim() ?? "" }));
  return { ready: !!window.__viewer, arch, cad, projectCards, url: location.href };
})()`);

const paletteOk = palette.ready
  && sameArray(palette.arch.ids, EXPECTED_ARCH)
  && sameArray(palette.cad.ids, EXPECTED_CAD)
  && palette.arch.clicks.every((entry) => entry.clicked)
  && palette.cad.clicks.every((entry) => entry.clicked)
  && palette.projectCards.some((entry) => entry.sample === "kit-fzk-haus");

const fzk = await evaluate(ws, `(async () => {
  const card = document.querySelector('.ribbon-asset-card[data-sample="kit-fzk-haus"]');
  const select = document.getElementById("sample-select");
  if (!card || !select) return { ok: false, reason: "missing FZK card/select", hasCard: !!card, hasSelect: !!select };
  card.click();
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const v = window.__viewer;
  if (!v?.exportCanonicalGeometry) return { ok: false, reason: "missing viewer/exportCanonicalGeometry" };
  const records = v.exportCanonicalGeometry();
  const breps = records.filter((record) => record.kind === "brep");
  const totalFaces = breps.reduce((sum, record) => sum + record.brep.shells.reduce((n, shell) => n + shell.faces.length, 0), 0);
  const triangularFaces = breps.reduce((sum, record) => sum + record.brep.shells.reduce((n, shell) => n + shell.faces.filter((face) => {
    const points = face.outerLoop?.curves?.flatMap((curve) => curve.points ?? []) ?? [];
    return points.length === 4;
  }).length, 0), 0);
  const nurbsFaces = breps.reduce((sum, record) => sum + record.brep.shells.reduce((n, shell) => n + shell.faces.filter((face) => face.surface?.kind === "nurbs").length, 0), 0);
  const closedRecords = breps.filter((record) => record.brep.shells.some((shell) => shell.isClosed === true)).length;
  const conversionSet = [...new Set(breps.map((record) => record.metadata?.conversion ?? null))];
  const facePolicySet = [...new Set(breps.map((record) => record.metadata?.facePolicy ?? null))];
  const sourceBasisSet = [...new Set(breps.map((record) => record.metadata?.sourceBasis ?? null))];
  return {
    ok: records.length === 83 && breps.length === 83 && totalFaces === 6887 && nurbsFaces === totalFaces && triangularFaces === 0 && closedRecords === 64,
    selectedSample: select.value,
    status: document.getElementById("status")?.textContent ?? null,
    recordCount: records.length,
    brepCount: breps.length,
    totalFaces,
    triangularFaces,
    nurbsFaces,
    closedRecords,
    conversionSet,
    facePolicySet,
    sourceBasisSet,
  };
})()`);

const ok = paletteOk && fzk.ok === true && fzk.selectedSample === "kit-fzk-haus";
console.log(JSON.stringify({
  deployedCommit,
  ok,
  paletteOk,
  palette: {
    archCount: palette.arch?.ids?.length ?? 0,
    cadCount: palette.cad?.ids?.length ?? 0,
    archIds: palette.arch?.ids ?? [],
    cadIds: palette.cad?.ids ?? [],
    failedClicks: [...(palette.arch?.clicks ?? []), ...(palette.cad?.clicks ?? [])].filter((entry) => !entry.clicked),
    projectCards: palette.projectCards ?? [],
  },
  fzk,
}, null, 2));

if (!ok) process.exitCode = 1;
ws.close();
