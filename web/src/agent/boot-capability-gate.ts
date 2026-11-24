// boot-capability-gate.ts — #1637: Boot-time GPU capability detection + 3-path user choice.
//
// Runs before model loading starts. A visitor is never required to change browser flags:
//
//   - Any real WebGPU adapter (dedicated, integrated, or unrecognised) proceeds straight to
//     the model. Integrated graphics get the small model (E2B) unless ?gemma_model= says
//     otherwise, plus a dismissible, non-blocking tip with the optional speed-up steps.
//   - Only when the browser has no usable WebGPU adapter at all (none, or software-only) is
//     the modal shown, because the ONNX model cannot run there:
//       Path 1 "flags":         optional steps to turn WebGPU on, then reload.
//       Path 2 "wasm-fallback": Reload with ?gpu=wasm (only when a GGUF is configured).
//       Path 3 "cad-only":      No AI. CREATE tab disabled; chat panel not mounted.
//       Demo card:              "Play demo video" — a recorded real session (demo-video.ts).
//
// Gate promise resolves immediately (no modal) when:
//   - a real WebGPU adapter exists, OR
//   - ?gpu=wasm already in URL (returning user from Path 2)

import { openDemoVideo } from "./demo-video";

export type AdapterClass = "dgpu" | "igpu" | "software" | "unknown" | "no-webgpu";
export type UserPath = "dgpu-proceed" | "flags" | "wasm-fallback" | "cad-only";
export type BootTier = "tier_0" | "tier_1" | "tier_2" | "tier_4";

const WASM_GGUF_CONFIGURED =
  !!(import.meta.env as Record<string, string | undefined>).VITE_WASM_LLAMA_TARGET_URL;

export function pathToTier(path: UserPath): BootTier {
  switch (path) {
    case "dgpu-proceed": return "tier_0";
    case "wasm-fallback": return "tier_1";
    case "flags": return "tier_0"; // user is fixing gpu; tier will be 0 on reload
    case "cad-only": return "tier_4";
  }
}

export function isGpuWasmForced(): boolean {
  try { return new URLSearchParams(location.search).get("gpu") === "wasm"; } catch { return false; }
}

// ── Boot plan (pure; unit-tested) ────────────────────────────────────────────

export const SMALL_MODEL_PARAM = "e2b";

/** Lower-cased ?gemma_model= value, "" when absent. */
export function explicitModelParam(search?: string): string {
  try {
    return (new URLSearchParams(search ?? location.search).get("gemma_model") ?? "").toLowerCase();
  } catch { return ""; }
}

export interface BootPlan {
  /** Show the blocking modal — only when no usable WebGPU adapter exists. */
  modal: boolean;
  /** Reload once with ?gemma_model=e2b so a weaker GPU loads the small model. */
  stepDownToSmallModel: boolean;
  /** Show the optional, dismissible "make it faster" tip. */
  speedTip: boolean;
}

/**
 * Decide what the boot gate does. The adapter's name never blocks a visitor: it only picks
 * the model size and whether to show the optional tip.
 */
export function planBoot(classification: AdapterClass, modelParam: string): BootPlan {
  if (classification === "no-webgpu" || classification === "software") {
    return { modal: true, stepDownToSmallModel: false, speedTip: false };
  }
  const igpu = classification === "igpu";
  return { modal: false, stepDownToSmallModel: igpu && modelParam === "", speedTip: igpu };
}

/** URL of this page with ?gemma_model=e2b added (other params and hash kept). */
export function smallModelUrl(href: string): string {
  const u = new URL(href);
  u.searchParams.set("gemma_model", SMALL_MODEL_PARAM);
  return u.href;
}

const _STEPDOWN_KEY = "bcg.steppedDown";

/**
 * Reload onto the small model after the default model failed to load. Returns false (and
 * does nothing) when the visitor chose a model explicitly or a step-down already happened.
 */
export function stepDownToSmallModel(reason: string): boolean {
  try {
    if (explicitModelParam() !== "") return false;
    sessionStorage.setItem(_STEPDOWN_KEY, reason.slice(0, 200));
    window.location.replace(smallModelUrl(location.href));
    return true;
  } catch { return false; }
}

// ── Adapter detection ────────────────────────────────────────────────────────

export async function detectAdapterClass(): Promise<{ classification: AdapterClass; deviceLabel: string; maxBufferSize: number }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gpu = (navigator as any).gpu;
    if (!gpu) return { classification: "no-webgpu", deviceLabel: "", maxBufferSize: 0 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" }).catch(() => null) as any | null;
    if (!adapter) return { classification: "no-webgpu", deviceLabel: "", maxBufferSize: 0 };

    const info = adapter.info ?? {};
    const vendor = String(info.vendor ?? "").toLowerCase();
    const arch   = String(info.architecture ?? "").toLowerCase();
    const isFallback = !!adapter.isFallbackAdapter;
    const deviceLabel = String(info.description ?? info.device ?? info.vendor ?? "").trim();
    // §#156 Layer 1: WebGPU maxBufferSize as VRAM tier proxy — logged at boot for diagnostics.
    const maxBufferSize: number = (adapter.limits?.maxBufferSize as number | undefined) ?? 0;
    if (maxBufferSize > 0) {
      console.info(`[boot-capability-gate] adapter maxBufferSize=${(maxBufferSize / 1024 ** 3).toFixed(1)}GB`);
    }

    let classification: AdapterClass;
    if (isFallback) {
      classification = "software";
    } else if (
      vendor === "intel" &&
      (arch.startsWith("gen-") || arch.includes("iris") || arch.includes("uhd") || arch.includes("xe-lp"))
    ) {
      classification = "igpu";
    } else if (vendor === "amd" && (arch.includes("vega-igpu") || arch.includes("gfx10-igpu"))) {
      classification = "igpu";
    } else if (vendor === "apple") {
      classification = "igpu";
    } else if (vendor === "") {
      classification = "unknown";
    } else {
      classification = "dgpu";
    }
    return { classification, deviceLabel, maxBufferSize };
  } catch {
    return { classification: "unknown", deviceLabel: "", maxBufferSize: 0 };
  }
}

// ── Modal DOM ────────────────────────────────────────────────────────────────

function _deviceCopy(cl: AdapterClass, label: string): string {
  if (cl === "no-webgpu" || cl === "software") {
    return "This browser has no usable WebGPU graphics adapter, which the in-browser AI model needs. Everything else in the app works without it.";
  }
  if (cl === "igpu") {
    const dev = label ? `(${label}) ` : "";
    return `Your browser is using integrated graphics ${dev}— Chrome is routing WebGPU to a slower GPU. Full AI speed requires the dedicated GPU.`;
  }
  return "Your browser's GPU configuration may limit AI performance.";
}

function _buildModal(
  container: HTMLElement,
  cl: AdapterClass,
  label: string,
): Promise<UserPath> {
  return new Promise<UserPath>((resolve) => {
    const modal = document.createElement("div");
    modal.className = "bcg-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "GPU capability options");

    const flagsUrl = "chrome://flags/#enable-unsafe-webgpu";

    modal.innerHTML = `
      <div class="bcg-inner">
        <h2 class="bcg-title">AI needs WebGPU</h2>
        <p class="bcg-device">${_deviceCopy(cl, label)}</p>

        <div class="bcg-paths">

          <div class="bcg-path bcg-path--recommended" tabindex="0" role="button" aria-label="Turn WebGPU on (optional)">
            <div class="bcg-path-header">
              <span class="bcg-path-badge">Optional</span>
              <span class="bcg-path-title">Turn WebGPU on</span>
              <span class="bcg-path-perf">AI enabled</span>
            </div>
            <p class="bcg-path-desc">Use Chrome or Edge, and check that <strong>Settings → System → Use graphics acceleration when available</strong> is on. If it already is, try the flag below.</p>
            <div class="bcg-path-steps" aria-label="Steps">
              <ol>
                <li>Open a new tab and paste this URL:</li>
              </ol>
              <div class="bcg-url-row">
                <code class="bcg-flag-url">${flagsUrl}</code>
                <button class="bcg-copy-btn" type="button" title="Copy URL" aria-label="Copy chrome flags URL">Copy</button>
              </div>
              <ol start="2">
                <li>Set the flag dropdown to <strong>Enabled</strong></li>
                <li>Click <strong>Relaunch</strong></li>
                <li>Return to this page</li>
              </ol>
            </div>
            <button class="bcg-path-btn bcg-path-btn--primary" type="button" data-path="flags" aria-label="I have done this — reload the page">
              I've done this — reload the page
            </button>
          </div>

          <div class="bcg-path" tabindex="0" role="button" aria-label="Use fallback inference (slower)">
            <div class="bcg-path-header">
              <span class="bcg-path-title">Use fallback inference</span>
              <span class="bcg-path-perf bcg-path-perf--slow">3–8 tok/s</span>
            </div>
            <p class="bcg-path-desc">Continue with WASM CPU inference. All AI features work; generation is slower.</p>
            <button class="bcg-path-btn" type="button" data-path="wasm-fallback" aria-label="Continue with slower AI">
              Continue with slower AI
            </button>
          </div>

          <div class="bcg-path" tabindex="0" role="button" aria-label="Watch the demo video">
            <div class="bcg-path-header">
              <span class="bcg-path-title">Watch the demo video</span>
              <span class="bcg-path-perf bcg-path-perf--none">No AI needed</span>
            </div>
            <p class="bcg-path-desc">See a recorded, unedited session of the app and its AI agent, instead of running the model yourself.</p>
            <button class="bcg-path-btn" type="button" data-demo-video="open" aria-label="Play demo video">
              Play demo video
            </button>
          </div>

          <div class="bcg-path" tabindex="0" role="button" aria-label="Skip AI features">
            <div class="bcg-path-header">
              <span class="bcg-path-title">Skip AI features</span>
              <span class="bcg-path-perf bcg-path-perf--none">CAD only</span>
            </div>
            <p class="bcg-path-desc">Use NURBS modeling, IFC import/export, and view tools. CREATE tab will be disabled.</p>
            <button class="bcg-path-btn" type="button" data-path="cad-only" aria-label="Continue without AI">
              Continue without AI
            </button>
          </div>

        </div>

        <p class="bcg-footer">This choice is saved for this session. Reload to change.</p>
      </div>
    `;

    if (!WASM_GGUF_CONFIGURED) {
      const wasmBtn = modal.querySelector<HTMLButtonElement>('[data-path="wasm-fallback"]');
      const wasmCard = wasmBtn?.closest(".bcg-path");
      const perf = wasmCard?.querySelector<HTMLElement>(".bcg-path-perf");
      const desc = wasmCard?.querySelector<HTMLElement>(".bcg-path-desc");
      if (perf) perf.textContent = "Unavailable";
      if (desc) desc.textContent = "This build has no GGUF WASM model configured. The Gemma ONNX Q4 model cannot run on ORT WASM/CPU.";
      if (wasmBtn) {
        wasmBtn.disabled = true;
        wasmBtn.removeAttribute("data-path");
        wasmBtn.textContent = "Fallback unavailable";
      }
    }

    // Copy button for chrome://flags URL
    modal.querySelector<HTMLButtonElement>(".bcg-copy-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard?.writeText(flagsUrl).catch(() => {});
      const btn = e.currentTarget as HTMLButtonElement;
      const orig = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = orig; }, 1500);
    });

    // Demo video: opens the player on top; the modal stays so the visitor can still choose a path.
    modal.querySelector<HTMLButtonElement>("[data-demo-video]")?.addEventListener("click", (e) => {
      e.stopPropagation();
      openDemoVideo();
    });

    // Path button clicks
    modal.querySelectorAll<HTMLButtonElement>("[data-path]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const path = btn.dataset.path as UserPath;
        if (path === "wasm-fallback") {
          // Reload with ?gpu=wasm — modal will be skipped on next boot
          const sep = location.search ? "&" : "?";
          window.location.assign(location.href + sep + "gpu=wasm");
          return; // navigation pending; don't resolve
        }
        if (path === "flags") {
          // Reload — user confirmed they enabled the flag
          window.location.reload();
          return;
        }
        modal.remove();
        resolve(path);
      });
    });

    // Keyboard: Tab cycles buttons; Enter/Space activates focused button
    modal.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        const el = document.activeElement as HTMLButtonElement;
        if (el?.dataset.path) el.click();
      }
    });

    container.appendChild(modal);

    // Focus first interactive element
    requestAnimationFrame(() => {
      modal.querySelector<HTMLButtonElement>(".bcg-copy-btn")?.focus();
    });
  });
}

// ── CSS ──────────────────────────────────────────────────────────────────────

function _injectStyles(): void {
  if (document.getElementById("bcg-styles")) return;
  const style = document.createElement("style");
  style.id = "bcg-styles";
  style.textContent = `
.bcg-modal {
  position: fixed; inset: 0; z-index: 9999;
  background: var(--overlay-bg);
  display: flex; align-items: center; justify-content: center;
  font-family: var(--sans);
  color: var(--ink);
  overflow-y: auto;
  padding: 24px 16px;
}
.bcg-inner {
  max-width: 600px; width: 100%;
  display: flex; flex-direction: column; gap: 20px;
}
.bcg-icon { font-size: 32px; }
.bcg-title { font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -.02em; }
.bcg-device { margin: 0; font-size: 13px; color: var(--ink-soft); line-height: 1.5; }
.bcg-paths { display: flex; flex-direction: column; gap: 12px; }
.bcg-path {
  background: var(--glass-bg); border: 1px solid var(--glass-stroke); border-radius: var(--r-lg);
  padding: 16px 18px; display: flex; flex-direction: column; gap: 10px;
  cursor: default; outline: none;
}
.bcg-path--recommended { border-color: var(--sanguine); background: var(--sanguine-tint); }
.bcg-path:focus-visible { border-color: var(--sanguine); box-shadow: 0 0 0 2px var(--sanguine-tint); }
.bcg-path-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.bcg-path-badge {
  font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
  background: var(--sanguine); color: var(--paper-solid); border-radius: var(--r-sm); padding: 2px 6px;
}
.bcg-path-title { font-size: 15px; font-weight: 600; }
.bcg-path-perf { font-size: 12px; color: var(--ok); margin-left: auto; font-variant-numeric: tabular-nums; }
.bcg-path-perf--slow { color: var(--warn); }
.bcg-path-perf--none { color: var(--ink-faint); }
.bcg-path-desc { margin: 0; font-size: 12px; color: var(--ink-soft); line-height: 1.5; }
.bcg-path-steps { font-size: 12px; color: var(--ink-dim); }
.bcg-path-steps ol { margin: 4px 0; padding-left: 18px; line-height: 1.8; }
.bcg-url-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
.bcg-flag-url {
  background: var(--paper-2); border: 1px solid var(--hairline); border-radius: var(--r-sm);
  padding: 4px 8px; font-size: 11px; color: var(--sanguine); flex: 1; user-select: all;
  font-family: var(--mono); word-break: break-all;
}
.bcg-copy-btn {
  background: var(--glass-bg); border: 1px solid var(--hairline-strong); border-radius: var(--r-sm);
  color: var(--ink-soft); font-size: 11px; padding: 4px 10px; cursor: pointer; white-space: nowrap;
  flex-shrink: 0; font-family: var(--sans);
}
.bcg-copy-btn:hover { background: var(--paper-3); color: var(--ink); }
.bcg-copy-btn:focus-visible { outline: 2px solid var(--sanguine); outline-offset: 2px; }
.bcg-alt-details { margin-top: 8px; }
.bcg-alt-details summary { cursor: pointer; color: var(--sanguine); font-size: 11px; }
.bcg-path-btn {
  align-self: flex-start;
  background: var(--glass-bg); border: 1px solid var(--hairline-strong); border-radius: var(--r-sm);
  color: var(--ink-soft); font-size: 12px; padding: 7px 14px; cursor: pointer; font-weight: 600;
  font-family: var(--sans); letter-spacing: 0.06em; text-transform: uppercase;
}
.bcg-path-btn:hover { background: var(--paper-3); color: var(--ink); border-color: var(--ink-faint); }
.bcg-path-btn:focus-visible { outline: 2px solid var(--sanguine); outline-offset: 2px; }
.bcg-path-btn--primary {
  background: var(--ink); border-color: var(--ink); color: var(--paper-solid);
}
.bcg-path-btn--primary:hover { background: var(--ink-soft); border-color: var(--ink-soft); }
.bcg-footer { margin: 0; font-size: 11px; color: var(--ink-faint); }
.bcg-tip {
  position: fixed; left: 16px; bottom: 16px; z-index: 10000; max-width: 380px;
  background: var(--paper-solid); border: 1px solid var(--hairline-strong); border-radius: var(--r-lg);
  padding: 12px 14px; font-family: var(--sans); color: var(--ink);
  box-shadow: 0 6px 24px rgba(0,0,0,.18);
  display: flex; flex-direction: column; gap: 6px;
}
.bcg-tip-head { display: flex; align-items: flex-start; gap: 8px; }
.bcg-tip-title { font-size: 12px; font-weight: 600; flex: 1; }
.bcg-tip-close {
  background: none; border: none; color: var(--ink-soft); font-size: 16px; line-height: 1;
  cursor: pointer; padding: 0 2px;
}
.bcg-tip-close:hover { color: var(--ink); }
.bcg-tip-desc { margin: 0; font-size: 11px; color: var(--ink-soft); line-height: 1.5; }
.bcg-tip ol { margin: 6px 0 0; padding-left: 18px; font-size: 11px; color: var(--ink-dim); line-height: 1.7; }
.bcg-tip .bcg-flag-url { display: inline; padding: 1px 4px; }
  `;
  document.head.appendChild(style);
}

// ── Gate promise ─────────────────────────────────────────────────────────────

let _gatePromise: Promise<UserPath> | null = null;
let _resolvedPath: UserPath | null = null;

export function getCapabilityGatePromise(): Promise<UserPath> {
  if (!_gatePromise) {
    // Should have been initialized by initCapabilityGate; resolve to dgpu as fallback.
    _gatePromise = Promise.resolve<UserPath>("dgpu-proceed");
  }
  return _gatePromise;
}

export function getResolvedPath(): UserPath | null { return _resolvedPath; }

export function isCadOnlyMode(): boolean { return _resolvedPath === "cad-only"; }
export function isWasmFallbackMode(): boolean {
  return _resolvedPath === "wasm-fallback" || isGpuWasmForced();
}

// ── Init (called by boot-screen.ts) ─────────────────────────────────────────

let _modalShown = false;
let _adapterClass: AdapterClass | null = null;

// ── Optional speed tip (non-blocking) ────────────────────────────────────────

const _TIP_DISMISS_KEY = "bcg.tipDismissed";

/** Small dismissible card: the model already runs; these steps only make it faster. */
function _showSpeedTip(container: HTMLElement, label: string): void {
  try { if (sessionStorage.getItem(_TIP_DISMISS_KEY)) return; } catch { /* storage blocked */ }
  if (document.querySelector(".bcg-tip")) return;
  const tip = document.createElement("div");
  tip.className = "bcg-tip";
  tip.setAttribute("role", "status");
  const dev = label ? ` (${label})` : "";
  const flagsUrl = "chrome://flags/#force-high-performance-gpu";
  tip.innerHTML = `
    <div class="bcg-tip-head">
      <span class="bcg-tip-title">AI is running on integrated graphics${dev}</span>
      <button class="bcg-tip-close" type="button" aria-label="Dismiss">×</button>
    </div>
    <p class="bcg-tip-desc">It works as is, with a smaller model. Nothing below is required.</p>
    <details class="bcg-alt-details">
      <summary>Optional: use a dedicated GPU for a larger, faster model</summary>
      <ol>
        <li>If this PC has a dedicated GPU, open <code class="bcg-flag-url">${flagsUrl}</code> in a new tab, set it to <strong>Enabled</strong>, and click <strong>Relaunch</strong>.</li>
        <li>Or: Windows Settings → System → Display → Graphics → <strong>chrome.exe</strong> → <strong>High performance</strong>, then relaunch Chrome.</li>
        <li>Then open this page again without <code>gemma_model=e2b</code> in the address.</li>
      </ol>
    </details>
  `;
  tip.querySelector<HTMLButtonElement>(".bcg-tip-close")?.addEventListener("click", () => {
    try { sessionStorage.setItem(_TIP_DISMISS_KEY, "1"); } catch { /* storage blocked */ }
    tip.remove();
  });
  container.appendChild(tip);
}

/** Returns true if the modal was shown (i.e. no usable WebGPU adapter and not ?gpu=wasm). */
export let wasCapabilityModalShown = false;
/** The user's chosen path after gate resolves (or "dgpu-proceed" if no modal). */
export let resolvedBootPath: UserPath = "dgpu-proceed";

export function initCapabilityGate(overlayContainer: HTMLElement): void {
  if (_gatePromise) return; // already initialized

  // If ?gpu=wasm is already set, user already picked Path 2 on a prior boot.
  if (isGpuWasmForced()) {
    _gatePromise = Promise.resolve<UserPath>("wasm-fallback");
    _resolvedPath = "wasm-fallback";
    resolvedBootPath = "wasm-fallback";
  } else {
    _gatePromise = (async (): Promise<UserPath> => {
      const { classification, deviceLabel, maxBufferSize } = await detectAdapterClass();
      // §#156 Layer 1: expose VRAM budget for diagnostics.
      if (maxBufferSize > 0) {
        (window as unknown as Record<string, unknown>).__adapterMaxBufferSize = maxBufferSize;
      }
      _adapterClass = classification;
      const plan = planBoot(classification, explicitModelParam());
      if (plan.stepDownToSmallModel) {
        // Integrated graphics: load the small model. One reload, before anything downloads.
        console.info(`[boot-capability-gate] ${classification} adapter — switching to the small model`);
        window.location.replace(smallModelUrl(location.href));
        return new Promise<UserPath>(() => { /* navigation pending */ });
      }
      // Any real WebGPU adapter proceeds with no modal: nobody has to change a browser flag.
      if (!plan.modal) {
        if (plan.speedTip) { _injectStyles(); _showSpeedTip(overlayContainer, deviceLabel); }
        _resolvedPath = "dgpu-proceed";
        resolvedBootPath = "dgpu-proceed";
        return "dgpu-proceed";
      }
      // Show modal only for software / no-webgpu (the ONNX model cannot run there).
      _injectStyles();
      _modalShown = true;
      wasCapabilityModalShown = true;
      const path = await _buildModal(overlayContainer, classification, deviceLabel);
      _resolvedPath = path;
      resolvedBootPath = path;
      return path;
    })();
  }

  // Expose resolved path as window global for harness receipt instrumentation (§#1637).
  _gatePromise.then((path) => {
    (window as unknown as Record<string, unknown>).__bcg = {
      modalShown: wasCapabilityModalShown,
      adapterClass: _adapterClass,
      path,
      tier: pathToTier(path),
      maxBufferSize: (window as unknown as Record<string, unknown>).__adapterMaxBufferSize ?? 0,
    };
  });
}
