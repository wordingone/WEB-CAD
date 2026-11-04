# Privacy and telemetry

WEB-CAD runs in your browser. In production builds that were deployed with a Sentry DSN
(`VITE_SENTRY_DSN`, as the GitHub Pages deploy workflow does), it reports **error and diagnostic
events to Sentry**. Source: `web/src/agent/telemetry-remote.ts`.

**What is sent**
- Error events (message and exception text, passed through a PII scrubber, `web/src/agent/telemetry-scrub.ts`).
- A few diagnostic events: a boot fingerprint of your GPU adapter (vendor, architecture, device, max buffer size,
  fallback classification), boot timing, and the app build (git SHA) as the release.
- An anonymous random user id (stored in your browser's localStorage under `web-cad-anon-user-id`) and a
  per-tab session id that is not stored.

Telemetry is off in development builds and when no DSN was set at build time.

**How to opt out**
- Add `?notelemetry=1` to the URL, or
- set localStorage key `web-cad-telemetry-opt-out` to `1` (browser console: `localStorage.setItem("web-cad-telemetry-opt-out","1")`).

Either takes effect on the next page load. Model weights are fetched from Hugging Face when the in-browser AI is used.
