#!/usr/bin/env node
// scripts/cold-cache-first-visit.mjs
// WEB-CAD#34 — Instrument the FIRST ever WEB-CAD Pages load.
//
// CRITICAL: Run ONCE on the true first visit to wordingone.github.io/WEB-CAD/
// This state (no Cache API, IDB, SW, HTTP disk cache, shader cache, OPFS for that
// origin) cannot be recreated after the first navigation. Mail Leo for review BEFORE
// running.
//
// Architecture:
//   1. Protect all pre-existing user tabs (record IDs, never touch them)
//   2. Create a NEW test tab at about:blank via Target.createTarget
//   3. Enable ALL CDP domains on new tab BEFORE Page.navigate
//   4. Navigate to PAGES_URL
//   5. Collect events until boot-complete + first inference + idle
//   6. Write cold-cache-first-visit-<ts>.json + screenshots/ directory
//   7. Do NOT close the test tab (stays open for visual inspection)

import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { CDP_BASE } from "./ports.mjs";

const PAGES_URL = "https://wordingone.github.io/WEB-CAD/";
const STATE_DIR = "B:/M/WEB-CAD/state";
const TS = new Date().toISOString().replace(/:/g, "").replace(/\..+/, "Z");
const OUT_DIR = join(STATE_DIR, `cold-cache-first-visit-${TS}`);
const SCREENSHOTS_DIR = join(OUT_DIR, "screenshots");
const OUT_JSON = join(OUT_DIR, `cold-cache-first-visit-${TS}.json`);

// Timeouts
const BOOT_TIMEOUT_MS  = 15 * 60 * 1000;  // 15min — cold boot with 5GB model download
const INFER_TIMEOUT_MS = 10 * 60 * 1000;  // 10min — first inference after boot

const scriptStartMs = Date.now();
function elapsed() { return Date.now() - scriptStartMs; }
function ts() { return new Date().toISOString(); }
function log(msg) { console.log(`[+${elapsed()}ms] ${msg}`); }

mkdirSync(SCREENSHOTS_DIR, { recursive: true });
log(`Output: ${OUT_DIR}`);

// ── Collectors ───────────────────────────────────────────────────────────────

const networkRequests = new Map();  // requestId → request data
const networkLog = [];              // finalized request records
const consoleMessages = [];         // all console messages
const errors = [];                  // errors only (duplicated from consoleMessages for quick access)
const swEvents = [];                // ServiceWorker domain events
const heapSnapshots = [];           // { ms, usedSize, totalSize, label }
const bootPhase = {
  script_start: 0,
  browser_connected: null,
  tab_created: null,
  domains_enabled: null,
  navigation_started: null,
  first_navigation_commit: null,
  dom_content_loaded: null,
  load_event_fired: null,
  sw_registered: null,
  sw_activated: null,
  model_manifest_ms: null,
  model_download_start_ms: null,
  model_download_end_ms: null,
  opfs_warm_start_ms: null,
  ort_init_start_ms: null,
  warmup_start_ms: null,
  warmup_end_ms: null,
  boot_complete_ms: null,
  capability_modal_shown_ms: null,
  capability_modal_dismissed_ms: null,
  first_inference_start_ms: null,
  first_inference_end_ms: null,
};
const screenshots = {};  // milestone → file path
const modelDownload = {
  total_bytes_expected: null,
  files: [],            // { file, loaded, total, throughputBytesPerSec, ts }
  loaded_bytes_total: 0,
};
const capabilityGate = {
  modal_shown: false,
  consent_auto_clicked: false,
  classification: null,
  resolved_path: null,
  dismissed_path: null,
};

let bootComplete = false;
let firstInferenceStarted = false;
let firstInferenceDone = false;

// ── CDP WebSocket helper ─────────────────────────────────────────────────────

function makeCdpWs(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let msgId = 1;
    const pending = new Map();
    const handlers = [];

    ws.onmessage = (m) => {
      const x = JSON.parse(m.data);
      if (x.id !== undefined && pending.has(x.id)) {
        const cb = pending.get(x.id);
        pending.delete(x.id);
        cb(x);
      } else if (!x.id) {
        for (const h of handlers) h(x);
      }
    };

    ws.onerror = (e) => reject(new Error(`WS error: ${e.message ?? "unknown"}`));
    ws.onclose = () => {};  // suppress post-close errors

    ws.addEventListener("open", () => {
      function send(method, params = {}) {
        return new Promise((res) => {
          const id = msgId++;
          pending.set(id, res);
          ws.send(JSON.stringify({ id, method, params }));
        });
      }
      function on(handler) { handlers.push(handler); }
      resolve({ send, on, ws });
    });
  });
}

// ── Screenshot helper ────────────────────────────────────────────────────────

async function captureScreenshot(cdp, milestone) {
  const r = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 85 });
  const data = r?.result?.data;
  if (!data) { log(`WARN: screenshot ${milestone} — no data returned`); return null; }
  const path = join(SCREENSHOTS_DIR, `${milestone}.jpg`);
  writeFileSync(path, Buffer.from(data, "base64"));
  screenshots[milestone] = path;
  log(`Screenshot: ${milestone} → ${path}`);
  return path;
}

async function maybeCaptureScreenshot(cdp, milestone) {
  if (screenshots[milestone]) return;  // already taken
  try { await captureScreenshot(cdp, milestone); } catch (e) { log(`WARN: screenshot ${milestone} failed: ${e.message}`); }
}

// ── Heap snapshot helper ─────────────────────────────────────────────────────

async function snapHeap(cdp, label) {
  try {
    const r = await cdp.send("Runtime.getHeapUsage");
    const h = r?.result;
    if (h) {
      const entry = { ms: elapsed(), label, used: h.usedSize, total: h.totalSize };
      heapSnapshots.push(entry);
      log(`Heap [${label}]: used=${(h.usedSize/1e6).toFixed(1)}MB total=${(h.totalSize/1e6).toFixed(1)}MB`);
    }
  } catch (_) {}
}

// ── Output writer ─────────────────────────────────────────────────────────────

function writeOutput() {
  const out = {
    url: PAGES_URL,
    started_at: new Date(scriptStartMs).toISOString(),
    completed_at: ts(),
    duration_ms: elapsed(),
    boot_phase_timing: bootPhase,
    capability_gate: capabilityGate,
    model_download: modelDownload,
    network: networkLog,
    console: consoleMessages,
    errors,
    service_worker_events: swEvents,
    heap_snapshots: heapSnapshots,
    screenshots,
    tab_stays_open: true,
  };
  writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  log(`Output written: ${OUT_JSON}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

// 1. Reach CDP and protect existing tabs
const allTargets = await fetch(`${CDP_BASE}/json`).then(r => r.json()).catch(() => null);
if (!allTargets) {
  console.error("ERROR: Cannot reach CDP at " + CDP_BASE + " — is shared browser running?");
  process.exit(1);
}

const userTabIds = new Set(allTargets.filter(t => t.type === "page").map(t => t.id));
log(`Protecting ${userTabIds.size} existing user tab(s): ${[...userTabIds].join(", ")}`);

// 2. Get browser-level WS URL from /json/version for Target.createTarget
const versionInfo = await fetch(`${CDP_BASE}/json/version`).then(r => r.json()).catch(() => null);
if (!versionInfo?.webSocketDebuggerUrl) {
  console.error("ERROR: Cannot get browser-level WS URL from /json/version");
  process.exit(1);
}

bootPhase.browser_connected = elapsed();
log(`Browser: ${versionInfo.Browser}`);

// Create test tab via any existing page tab (Target.createTarget is tab-agnostic)
const existingTab = allTargets.find(t => t.type === "page");
if (!existingTab) {
  console.error("ERROR: No existing page tab found — open a blank tab in the shared browser");
  process.exit(1);
}

log(`Creating test tab via ${existingTab.id}...`);
const tmpConn = await makeCdpWs(existingTab.webSocketDebuggerUrl);
const createResult = await tmpConn.send("Target.createTarget", { url: "about:blank" });
const testTabId = createResult?.result?.targetId;
tmpConn.ws.onclose = () => {};
tmpConn.ws.close();  // disconnect from user tab — tab stays open, untouched

if (!testTabId) {
  console.error("ERROR: Target.createTarget failed");
  process.exit(1);
}

bootPhase.tab_created = elapsed();
log(`Test tab created: ${testTabId}`);

// Wait for tab to appear in /json
let testTabInfo = null;
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 250));
  const fresh = await fetch(`${CDP_BASE}/json`).then(r => r.json()).catch(() => []);
  testTabInfo = fresh.find(t => t.id === testTabId);
  if (testTabInfo) break;
}
if (!testTabInfo) {
  console.error("ERROR: Test tab not found in /json after 5s");
  process.exit(1);
}

// 3. Connect CDP to test tab
const cdp = await makeCdpWs(testTabInfo.webSocketDebuggerUrl);
log(`Connected to test tab WS`);

// 4. Register event dispatcher BEFORE enabling domains
cdp.on(async (msg) => {
  const method = msg.method ?? "";
  const params = msg.params ?? {};

  // Network events
  if (method === "Network.requestWillBeSent") {
    const r = params.request;
    networkRequests.set(params.requestId, {
      requestId:  params.requestId,
      url:        r.url,
      method:     r.method,
      headers:    r.headers,
      initiator:  params.initiator?.type,
      started_ms: elapsed(),
      type:       params.type,
      status:     null,
      resp_headers: null,
      encoded_bytes: null,
      total_bytes: null,
      ttfb_ms:    null,
      download_ms: null,
      cache_hit:  false,
    });
  }
  if (method === "Network.responseReceived") {
    const req = networkRequests.get(params.requestId);
    if (req) {
      const h = params.response?.headers ?? {};
      req.status       = params.response?.status;
      req.resp_headers = h;
      req.ttfb_ms      = elapsed() - req.started_ms;
      req.mime_type    = params.response?.mimeType;
      req.from_cache   = params.response?.fromDiskCache || params.response?.fromPrefetchCache;
      req.cache_hit    = !!(h["age"] || h["cf-cache-status"]);
    }
  }
  if (method === "Network.loadingFinished") {
    const req = networkRequests.get(params.requestId);
    if (req) {
      req.encoded_bytes = params.encodedDataLength;
      req.download_ms   = elapsed() - req.started_ms;
      networkLog.push({ ...req });
      networkRequests.delete(params.requestId);
    }
  }
  if (method === "Network.loadingFailed") {
    const req = networkRequests.get(params.requestId);
    if (req) {
      req.failed = params.errorText;
      req.download_ms = elapsed() - req.started_ms;
      networkLog.push({ ...req });
      networkRequests.delete(params.requestId);
      const errEntry = { ms: elapsed(), type: "network-load-failed", url: req.url, error: params.errorText };
      errors.push(errEntry);
    }
  }

  // Runtime console + exceptions
  if (method === "Runtime.consoleAPICalled") {
    const args = (params.args ?? []).map(a => a.value ?? a.description ?? "");
    const text = args.join(" ");
    const entry = { ms: elapsed(), level: params.type, text };
    consoleMessages.push(entry);
    if (params.type === "error" || params.type === "warning") {
      errors.push({ ms: elapsed(), type: "console-" + params.type, text });
    }

    // Parse agentmodel:* spy messages (JSON-prefixed by injected spy)
    if (text.startsWith("[agentmodel-spy]")) {
      try {
        const payload = JSON.parse(text.replace("[agentmodel-spy] ", ""));
        await handleAgentModelEvent(payload, cdp);
      } catch (_) {}
    }
    // Parse bcg-spy messages (boot-capability-gate events)
    if (text.startsWith("[bcg-spy]")) {
      try {
        const payload = JSON.parse(text.replace("[bcg-spy] ", ""));
        await handleBcgEvent(payload, cdp);
      } catch (_) {}
    }
    // Parse arc-spy messages (__arc state changes)
    if (text.startsWith("[arc-spy]")) {
      try {
        const payload = JSON.parse(text.replace("[arc-spy] ", ""));
        if (payload.state === "ready" && !bootComplete) {
          bootComplete = true;
          bootPhase.boot_complete_ms = elapsed();
          log(`Boot complete! arc.state=ready`);
          await maybeCaptureScreenshot(cdp, "06-boot-complete");
          await snapHeap(cdp, "boot_complete");
        }
        if (payload.state === "generating" && !firstInferenceStarted) {
          firstInferenceStarted = true;
          bootPhase.first_inference_start_ms = elapsed();
          log(`First inference started`);
        }
        if (payload.state === "ready" && firstInferenceStarted && !firstInferenceDone) {
          firstInferenceDone = true;
          bootPhase.first_inference_end_ms = elapsed();
          log(`First inference complete`);
          await maybeCaptureScreenshot(cdp, "07-post-inference");
          await snapHeap(cdp, "post_inference");
        }
      } catch (_) {}
    }
  }
  if (method === "Runtime.exceptionThrown") {
    const exc = params.exceptionDetails;
    const errEntry = {
      ms: elapsed(),
      type: "js-exception",
      text: exc?.text ?? "unknown",
      url: exc?.url,
      line: exc?.lineNumber,
      col: exc?.columnNumber,
      stack: exc?.exception?.description,
    };
    errors.push(errEntry);
    consoleMessages.push({ ms: elapsed(), level: "exception", text: errEntry.text });
    log(`JS EXCEPTION: ${errEntry.text} at ${errEntry.url}:${errEntry.line}`);
  }

  // Page lifecycle
  if (method === "Page.domContentEventFired") {
    bootPhase.dom_content_loaded = elapsed();
    log("DOMContentLoaded");
  }
  if (method === "Page.loadEventFired") {
    bootPhase.load_event_fired = elapsed();
    log("load event fired");
    await maybeCaptureScreenshot(cdp, "01-load-event");
    await snapHeap(cdp, "load_event");
  }
  if (method === "Page.lifecycleEvent") {
    if (params.name === "commit") {
      bootPhase.first_navigation_commit = elapsed();
    }
    if (params.name === "firstPaint") {
      log("firstPaint lifecycle");
      await maybeCaptureScreenshot(cdp, "02-first-paint");
    }
    if (params.name === "firstContentfulPaint") {
      log("firstContentfulPaint lifecycle");
    }
  }
  if (method === "Page.frameNavigated" && params.frame?.url?.includes("WEB-CAD")) {
    bootPhase.navigation_started = elapsed();
    log(`Frame navigated to WEB-CAD`);
  }

  // ServiceWorker events
  if (method.startsWith("ServiceWorker.")) {
    const swEntry = { ms: elapsed(), method, params: JSON.stringify(params).slice(0, 500) };
    swEvents.push(swEntry);
    if (method === "ServiceWorker.workerRegistrationUpdated") {
      bootPhase.sw_registered = bootPhase.sw_registered ?? elapsed();
      log(`SW registered: ${params.registrations?.[0]?.scopeURL}`);
    }
    if (method === "ServiceWorker.workerVersionUpdated") {
      const v = params.versions?.[0];
      if (v?.status === "activated") {
        bootPhase.sw_activated = bootPhase.sw_activated ?? elapsed();
        log(`SW activated`);
      }
    }
  }

  // Log domain errors
  if (method === "Log.entryAdded") {
    const entry = params.entry;
    if (entry.level === "error") {
      errors.push({ ms: elapsed(), type: "log-entry-error", text: entry.text, url: entry.url });
    }
    consoleMessages.push({ ms: elapsed(), level: entry.level, text: entry.text });
  }
});

// 5. Enable ALL domains BEFORE navigation
log("Enabling CDP domains...");
await cdp.send("Network.enable", { maxResourceBufferSize: 100_000_000, maxTotalBufferSize: 500_000_000 });
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
await cdp.send("Page.setLifecycleMitsEnabled", { enabled: true }).catch(() =>
  cdp.send("Page.setLifecycleEventsEnabled", { enabled: true }).catch(() => {})
);
await cdp.send("Performance.enable");
await cdp.send("Log.enable");
// ServiceWorker domain — best effort (may not be available in all Chrome versions)
await cdp.send("ServiceWorker.enable").catch(e => log(`WARN: ServiceWorker.enable failed: ${e.message}`));
// IndexedDB domain — enable for structural tracking
await cdp.send("IndexedDB.enable").catch(e => log(`WARN: IndexedDB.enable failed: ${e.message}`));

// 6. Inject spy scripts before navigation (runs on every new document before any page JS)
// Spy 1: agentmodel:* event → console.log with [agentmodel-spy] prefix
// Spy 2: boot-capability-gate events → console.log with [bcg-spy] prefix
// Spy 3: window.__arc state → poll every 2s via setInterval → console.log with [arc-spy]
// Spy 4: Cache API monkey-patch → log every cache.put call
// Spy 5: IDB open/put observer

await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
(function() {
  // agentmodel:* events fire on window — register immediately before any page JS.
  // These do NOT require the DOM (window is always available at inject time).
  var _spy_events = [
    'agentmodel:manifest','agentmodel:loading','agentmodel:returning-user',
    'agentmodel:opfs-warm-start','agentmodel:boot-complete','agentmodel:error',
    'agentmodel:drafter:loading',
  ];
  _spy_events.forEach(function(evt) {
    window.addEventListener(evt, function(e) {
      var payload = { event: evt, ts: performance.now(), detail: e.detail ?? null };
      console.log('[agentmodel-spy] ' + JSON.stringify(payload));
    });
  });

  // Everything else needs the DOM. document.documentElement is null before HTML
  // parsing — wrapping in DOMContentLoaded guarantees it exists.
  document.addEventListener('DOMContentLoaded', function() {

    // Boot-capability-gate spy — watch for modal and path choice
    var _bcg_fired = false;
    var _bcg_observer = new MutationObserver(function(mutations) {
      for (var m of mutations) {
        for (var node of m.addedNodes) {
          if (node.classList && node.classList.contains('bcg-modal')) {
            if (!_bcg_fired) {
              _bcg_fired = true;
              console.log('[bcg-spy] ' + JSON.stringify({ event: 'modal-shown', ts: performance.now() }));
            }
            node.querySelectorAll('[data-path]').forEach(function(btn) {
              btn.addEventListener('click', function(e) {
                console.log('[bcg-spy] ' + JSON.stringify({ event: 'path-chosen', path: btn.dataset.path, ts: performance.now() }));
              }, { once: true });
            });
          }
        }
      }
    });
    _bcg_observer.observe(document.documentElement, { childList: true, subtree: true });

    // Consent modal auto-click — the model download consent modal blocks boot.
    // Click "Download model" automatically so the harness can measure the full flow.
    var _clickConsent = function() {
      var btn = document.querySelector('button[data-action="download-model"]')
        || Array.prototype.find.call(document.querySelectorAll('button'), function(b) {
             return b.textContent.trim().includes('Download model');
           });
      if (btn) {
        btn.click();
        console.log('[bcg-spy] ' + JSON.stringify({ event: 'consent-auto-clicked', ts: performance.now() }));
        return true;
      }
      return false;
    };
    if (!_clickConsent()) {
      var _consent_obs = new MutationObserver(function() {
        if (_clickConsent()) _consent_obs.disconnect();
      });
      _consent_obs.observe(document.body, { childList: true, subtree: true });
    }

    // arc state poller — detect window.__arc.state transitions
    var _lastArcState = null;
    setInterval(function() {
      var s = window.__arc && window.__arc.state;
      if (s && s !== _lastArcState) {
        _lastArcState = s;
        console.log('[arc-spy] ' + JSON.stringify({ state: s, recycleCount: window.__arc.recycleCount ?? 0, ts: performance.now() }));
      }
    }, 500);

    // Cache API spy — intercept cache.put to track model file caching
    if (typeof caches !== 'undefined') {
      var _orig_open = caches.open.bind(caches);
      caches.open = function(cacheName) {
        return _orig_open(cacheName).then(function(cache) {
          var _orig_put = cache.put.bind(cache);
          cache.put = function(req, resp) {
            var url = typeof req === 'string' ? req : (req && req.url) || '?';
            var size = resp.headers.get('content-length') || null;
            console.log('[agentmodel-spy] ' + JSON.stringify({
              event: 'cache.put', cache: cacheName, url: url, size: size, ts: performance.now()
            }));
            return _orig_put(req, resp);
          };
          return cache;
        });
      };
    }

  }); // end DOMContentLoaded
})();
  `,
});

bootPhase.domains_enabled = elapsed();
log("All domains enabled. Injecting spy scripts done.");

// 7. Navigate to PAGES_URL
log(`Navigating to ${PAGES_URL} ...`);
await cdp.send("Page.navigate", { url: PAGES_URL });
bootPhase.navigation_started = elapsed();

// Initial screenshot — loading screen should appear almost immediately
await new Promise(r => setTimeout(r, 2000));
await maybeCaptureScreenshot(cdp, "00-loading-screen-2s");
await snapHeap(cdp, "navigation_start");

// ── agentmodel event handlers ───────────────────────────────────────────────

async function handleAgentModelEvent(payload, cdp) {
  const { event, detail, ts: evTs } = payload;

  if (event === "agentmodel:manifest") {
    bootPhase.model_manifest_ms = elapsed();
    modelDownload.total_bytes_expected = detail?.totalBytesExpected ?? null;
    log(`agentmodel:manifest — totalBytesExpected=${modelDownload.total_bytes_expected}`);
    await maybeCaptureScreenshot(cdp, "03-manifest");
  }

  if (event === "agentmodel:loading") {
    if (bootPhase.model_download_start_ms === null && (detail?.bytes ?? 0) > 0) {
      bootPhase.model_download_start_ms = elapsed();
      log(`agentmodel:loading — download started`);
    }
    if (bootPhase.ort_init_start_ms === null && detail?.phase === "model-init") {
      bootPhase.ort_init_start_ms = elapsed();
      log(`agentmodel:loading phase=model-init — ORT init started`);
      bootPhase.model_download_end_ms = elapsed();
      await maybeCaptureScreenshot(cdp, "04-model-download-complete");
      await snapHeap(cdp, "model_download_end");
    }
    if (bootPhase.warmup_start_ms === null && detail?.phase === "warmup") {
      bootPhase.warmup_start_ms = elapsed();
      log(`agentmodel:loading phase=warmup — warmup started`);
    }
    if (detail?.phase === "drafter") {
      if (bootPhase.warmup_end_ms === null) {
        bootPhase.warmup_end_ms = elapsed();
        log(`agentmodel:loading phase=drafter — warmup done`);
      }
    }
    if (detail?.file) {
      const shortFile = detail.file.split("/").pop() ?? detail.file;
      if (detail.bytes > 0) modelDownload.loaded_bytes_total = Math.max(modelDownload.loaded_bytes_total, detail.bytes);
      modelDownload.files.push({
        file: shortFile,
        loaded: detail.bytes ?? 0,
        total: detail.total ?? 0,
        throughput: detail.throughputBytesPerSec ?? null,
        phase: detail.phase ?? null,
        ts: elapsed(),
      });
    }
  }

  if (event === "cache.put") {
    log(`cache.put in '${payload.cache}': ${payload.url} (${payload.size ?? "?"}B)`);
  }

  if (event === "agentmodel:opfs-warm-start") {
    bootPhase.opfs_warm_start_ms = elapsed();
    log(`agentmodel:opfs-warm-start`);
  }

  if (event === "agentmodel:boot-complete") {
    // Also handled by arc-spy but catch here too
    if (bootPhase.boot_complete_ms === null) {
      bootPhase.boot_complete_ms = elapsed();
      bootComplete = true;
      log(`agentmodel:boot-complete`);
      await maybeCaptureScreenshot(cdp, "05-boot-complete-event");
      await snapHeap(cdp, "boot_complete_event");
    }
  }

  if (event === "agentmodel:error") {
    const errEntry = { ms: elapsed(), type: "agentmodel-error", detail };
    errors.push(errEntry);
    log(`agentmodel:error: ${JSON.stringify(detail)}`);
  }
}

async function handleBcgEvent(payload, cdp) {
  const { event } = payload;
  if (event === "modal-shown") {
    capabilityGate.modal_shown = true;
    bootPhase.capability_modal_shown_ms = elapsed();
    log(`Boot capability modal shown`);
    await maybeCaptureScreenshot(cdp, "02-capability-modal");
  }
  if (event === "consent-auto-clicked") {
    capabilityGate.consent_auto_clicked = true;
    bootPhase.capability_modal_dismissed_ms = elapsed();
    log(`Consent modal auto-clicked by spy`);
    await maybeCaptureScreenshot(cdp, "03-consent-auto-clicked");
  }
  if (event === "path-chosen") {
    capabilityGate.resolved_path = payload.path;
    bootPhase.capability_modal_dismissed_ms = bootPhase.capability_modal_dismissed_ms ?? elapsed();
    log(`Boot capability modal path chosen: ${payload.path}`);
    await maybeCaptureScreenshot(cdp, "03-modal-path-chosen");
  }
}

// ── Boot completion wait ─────────────────────────────────────────────────────

log(`Waiting for boot complete (timeout ${BOOT_TIMEOUT_MS/60000}min)...`);
const bootStart = Date.now();
while (!bootComplete && (Date.now() - bootStart) < BOOT_TIMEOUT_MS) {
  await new Promise(r => setTimeout(r, 5000));
  const ms = Date.now() - bootStart;
  log(`  Waiting for boot... ${(ms/1000).toFixed(0)}s elapsed`);

  // Periodic heap + performance snapshots during long download
  if (ms % 60_000 < 5000) {
    await snapHeap(cdp, `periodic_${Math.floor(ms/60_000)}min`);
  }

  // Take a model-download-progress screenshot every 2 minutes
  const bucketMin = Math.floor(ms / 120_000);
  const bucketKey = `download-progress-${bucketMin * 2}min`;
  if (!screenshots[bucketKey] && ms > 60_000) {
    await maybeCaptureScreenshot(cdp, bucketKey);
  }
}

if (!bootComplete) {
  log("TIMEOUT: boot did not complete within time limit");
  errors.push({ ms: elapsed(), type: "boot-timeout", text: `Boot timeout after ${BOOT_TIMEOUT_MS/1000}s` });
}

// 8. Collect Performance metrics after boot
try {
  const perfResult = await cdp.send("Performance.getMetrics");
  const metrics = {};
  for (const m of perfResult?.result?.metrics ?? []) {
    metrics[m.name] = m.value;
  }
  log(`Performance metrics collected: ${Object.keys(metrics).length} entries`);

  // Write metrics into output
  writeFileSync(join(OUT_DIR, "performance-metrics.json"), JSON.stringify(metrics, null, 2));
} catch (e) {
  log(`WARN: Performance.getMetrics failed: ${e.message}`);
}

// 9. Final screenshots if not yet taken
await maybeCaptureScreenshot(cdp, "08-final-state");
await snapHeap(cdp, "final");

// 10. Write output
writeOutput();

console.log(`
╔══════════════════════════════════════════════════════╗
│  cold-cache-first-visit — ${ts()}
├──────────────────────────────────────────────────────┤
│  duration        : ${(elapsed()/1000).toFixed(1)}s
│  boot complete   : ${bootComplete ? "YES" : "TIMEOUT"}
│  cap modal shown : ${capabilityGate.modal_shown}
│  cap path        : ${capabilityGate.resolved_path ?? "n/a"}
│  network requests: ${networkLog.length}
│  console messages: ${consoleMessages.length}
│  errors          : ${errors.length}
│  sw events       : ${swEvents.length}
│  heap snapshots  : ${heapSnapshots.length}
│  screenshots     : ${Object.keys(screenshots).length}
├──────────────────────────────────────────────────────┤
│  Output: ${OUT_JSON}
│  Screenshots: ${SCREENSHOTS_DIR}
├──────────────────────────────────────────────────────┤
│  ⚠ Test tab stays open for visual inspection        │
│  (lint-browser-close:ok — tab created by this script)│
╚══════════════════════════════════════════════════════╝
`);

// Test tab stays open — per WEB-CAD#34 spec and lint guard.
// The tab was created by this script (Target.createTarget) and is intentionally
// left open so Leo can visually inspect the boot result.
// lint-browser-close:ok — stays open, not closed.
