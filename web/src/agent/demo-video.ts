// demo-video.ts — "Play demo video": a recorded, real session of the app and its in-browser AI
// agent, for visitors who cannot or do not want to run the model.
//
// The video is a static file (web/public/demo/demo.mp4) recorded by scripts/record-demo.mjs.
// It loads only when a visitor asks for it (preload="none", no src until the overlay opens).
// The caption comes from web/public/demo/demo.json, written by the recorder, so the date,
// hardware, model and any speed-up note always describe the file that is actually served.

export interface DemoMeta {
  /** ISO date the session was recorded, e.g. "2026-11-24". */
  recordedOn: string;
  /** Hardware label, e.g. "an RTX 4090". */
  hardware: string;
  /** Model label, e.g. "Gemma 4 E4B". */
  model: string;
  /** Present only when waiting segments were shortened, e.g. 4 for "waits shortened 4x". */
  waitSpeedup?: number | null;
  /** Optional extra sentence, e.g. that the model files were already cached. */
  note?: string | null;
}

export const DEMO_VIDEO_URL = "demo/demo.mp4";
export const DEMO_POSTER_URL = "demo/demo-poster.jpg";
export const DEMO_META_URL = "demo/demo.json";
export const DEMO_OVERLAY_ID = "demo-video-overlay";

const FALLBACK_CAPTION = "Recorded demo of a real session: the app and its in-browser AI agent.";

/** Pure: the caption line under the player. */
export function demoCaption(meta: Partial<DemoMeta> | null | undefined): string {
  if (!meta || !meta.recordedOn || !meta.hardware || !meta.model) return FALLBACK_CAPTION;
  const base = `Recorded ${meta.recordedOn} on ${meta.hardware}, ${meta.model}, real session`;
  const x = meta.waitSpeedup;
  const speed = typeof x === "number" && x > 1 ? ` Waits shortened ${x}x.` : "";
  const note = meta.note ? ` ${meta.note}` : "";
  return `${base}.${speed}${note}`;
}

const STYLE_ID = "demo-video-styles";

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.dv-overlay {
  position: fixed; inset: 0; z-index: 10050;
  background: var(--overlay-bg, rgba(0,0,0,.72));
  display: flex; align-items: center; justify-content: center;
  padding: 24px 16px; font-family: var(--sans, system-ui, sans-serif);
}
.dv-card {
  background: var(--paper-solid, #faf7ee); color: var(--ink, #1c1c20);
  border: 1px solid var(--hairline-strong, rgba(0,0,0,.2)); border-radius: var(--r-lg, 10px);
  box-shadow: 0 24px 80px rgba(0,0,0,.45);
  width: min(960px, 100%); max-height: 100%; display: flex; flex-direction: column; gap: 10px;
  padding: 12px 14px 12px;
}
.dv-head { display: flex; align-items: center; gap: 8px; }
.dv-title { font-size: 13px; font-weight: 600; flex: 1; }
.dv-close {
  background: none; border: 1px solid var(--hairline-strong, rgba(0,0,0,.2)); border-radius: var(--r-sm, 4px);
  color: var(--ink-soft, inherit); font: 600 12px var(--sans, system-ui, sans-serif);
  padding: 4px 10px; cursor: pointer;
}
.dv-close:hover { color: var(--ink, inherit); border-color: var(--ink-faint, currentColor); }
.dv-close:focus-visible { outline: 2px solid var(--sanguine, #c0392b); outline-offset: 2px; }
.dv-video { width: 100%; max-height: calc(100vh - 170px); background: #000; border-radius: var(--r-sm, 4px); }
.dv-caption { margin: 0; font-size: 12px; line-height: 1.5; color: var(--ink-soft, inherit); }
.dv-btn {
  background: var(--glass-bg, transparent); border: 1px solid var(--hairline-strong, rgba(128,128,128,.4));
  border-radius: var(--r-sm, 4px); color: var(--ink-soft, inherit);
  font: 600 12px var(--sans, system-ui, sans-serif); padding: 7px 14px; cursor: pointer;
}
.dv-btn:hover { color: var(--ink, inherit); }
.dv-btn:focus-visible { outline: 2px solid var(--sanguine, #c0392b); outline-offset: 2px; }
  `;
  document.head.appendChild(style);
}

let _meta: Promise<Partial<DemoMeta> | null> | null = null;
function loadMeta(): Promise<Partial<DemoMeta> | null> {
  if (!_meta) {
    _meta = fetch(DEMO_META_URL, { cache: "no-cache" })
      .then((r) => (r.ok ? (r.json() as Promise<Partial<DemoMeta>>) : null))
      .catch(() => null);
  }
  return _meta;
}

// ---- Deep link: ?demo=1 --------------------------------------------------------------------------

/** Pure: does this query string ask for the demo video (?demo=1)? Other params are ignored. */
export function isDemoDeepLink(search: string): boolean {
  try { return new URLSearchParams(search).get("demo") === "1"; } catch { return false; }
}

/** Pure: the same URL without the demo param (other params and the hash are kept). */
export function withoutDemoParam(href: string): string {
  const u = new URL(href);
  u.searchParams.delete("demo");
  return u.href;
}

const _closeWaiters: Array<() => void> = [];

/**
 * Resolves at once when the player is not open; otherwise when it closes. The model prefetch waits on
 * this, so a visitor who opened the page only to watch the video downloads nothing until they close it.
 */
export function whenDemoClosed(): Promise<void> {
  if (!document.getElementById(DEMO_OVERLAY_ID)) return Promise.resolve();
  return new Promise<void>((res) => { _closeWaiters.push(res); });
}

/** Called once at boot: with ?demo=1 in the address, open the player before anything else. */
export function openDemoFromUrl(): boolean {
  if (!isDemoDeepLink(location.search)) return false;
  openDemoVideo();
  return true;
}

/** Close the player if it is open. */
export function closeDemoVideo(): void {
  const overlay = document.getElementById(DEMO_OVERLAY_ID);
  if (!overlay) return;
  const v = overlay.querySelector("video");
  if (v) { v.pause(); v.removeAttribute("src"); v.load(); }
  overlay.remove();
  document.removeEventListener("keydown", onKeyDown, true);
  // A deep-linked visit continues as a normal visit: drop ?demo=1 so a reload does not reopen it.
  try { if (isDemoDeepLink(location.search)) history.replaceState(history.state, "", withoutDemoParam(location.href)); } catch { /* */ }
  for (const w of _closeWaiters.splice(0)) w();
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  closeDemoVideo();
}

/** Open the in-page player. The video file is requested only here, never at page load. */
export function openDemoVideo(): void {
  if (document.getElementById(DEMO_OVERLAY_ID)) return;
  injectStyles();
  const overlay = document.createElement("div");
  overlay.id = DEMO_OVERLAY_ID;
  overlay.className = "dv-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Demo video");
  overlay.innerHTML = `
    <div class="dv-card">
      <div class="dv-head">
        <span class="dv-title">Demo video</span>
        <button class="dv-close" type="button" aria-label="Close demo video">Close</button>
      </div>
      <video class="dv-video" controls playsinline preload="none" poster="${DEMO_POSTER_URL}"></video>
      <p class="dv-caption"></p>
    </div>
  `;
  const video = overlay.querySelector<HTMLVideoElement>("video")!;
  const caption = overlay.querySelector<HTMLElement>(".dv-caption")!;
  caption.textContent = demoCaption(null);
  void loadMeta().then((m) => { caption.textContent = demoCaption(m); });
  video.src = DEMO_VIDEO_URL;
  overlay.querySelector<HTMLButtonElement>(".dv-close")!.addEventListener("click", closeDemoVideo);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeDemoVideo(); });
  document.addEventListener("keydown", onKeyDown, true);
  document.body.appendChild(overlay);
  overlay.querySelector<HTMLButtonElement>(".dv-close")!.focus();
}

/** Build a "Play demo video" button that opens the player. */
export function makeDemoButton(label = "Play demo video"): HTMLButtonElement {
  injectStyles();
  const b = document.createElement("button");
  b.type = "button";
  b.className = "dv-btn";
  b.dataset.demoVideo = "open";
  b.textContent = label;
  b.addEventListener("click", (e) => { e.stopPropagation(); openDemoVideo(); });
  return b;
}
