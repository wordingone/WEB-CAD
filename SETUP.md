# SETUP — WEB-CAD

Developer environment setup.

## Prerequisites

- [Bun](https://bun.sh/) ≥ 1.1
- Node 20+ (for scripts that call `node` directly)
- A modern browser with WebGPU for the AI agent (Chrome 113+, Edge 113+; Safari 18+ partial)
- Git

## Clone and install

```bash
git clone https://github.com/wordingone/WEB-CAD
cd WEB-CAD
bun install
```

## Dev server

```bash
bun run web:dev
# → http://localhost:5847 (hot reload via Vite)
```

The dev server enforces `--port 5847`. Do not change the port — the shared-browser CDP automation expects it.

## Type checking

```bash
bun run typecheck       # root tsconfig (scripts, tools)
bun run web:typecheck   # web/tsconfig.json (strict mode)
```

## Tests

```bash
bun test web/           # full web test suite (~1509 tests)
```

## Audit gate stack

Run before opening a PR:

```bash
bun run verify          # typecheck + web:typecheck + audit:stubs + audit:parity + audit:dispatch + more
bun scripts/audit-aliases.ts   # synonym / alias trademark audit (separate from verify)
```

`bun run verify` bundles all CI-relevant checks. If it exits 0, the PR is ready.

## Build

```bash
bun run web:build       # outputs to web/dist/
bun run web:preview     # serve the built dist locally
```

## Repo-level infra scripts

```bash
bash scripts/setup-hooks.sh         # install .githooks (gitleaks pre-commit)
bash scripts/enable-auto-merge.sh   # enable GitHub auto-merge on the repo (admin only, one-time)
```

## Environment notes

- `.claude/` is gitignored — contains local hooks, session state, skills. Not for committed code.
- `state/` is gitignored — runtime state (KG graph, hook logs, learnings).
- `outputs/` and `data/` are gitignored — built training artifacts.
- Vite config: `web/vite.config.ts`. Plugin deps: `vite-plugin-wasm`, `vite-plugin-top-level-await`.

## Build and deploy

### Build for production

```bash
bun run web:build       # outputs to web/dist/
bun run web:preview     # serve built dist locally at http://localhost:4173
```

### Deploy to GitHub Pages

The repo uses GitHub Actions to deploy `web/dist/` to GitHub Pages on every push to `master`. No manual step needed — merge to master, CI builds and publishes.

To verify the deployment pipeline locally before pushing:

```bash
bun run verify:deploy   # validates dist/ structure, checks required assets exist
```

### Cold-cache first-visit verification

After a Pages deploy, verify that a first-time visitor (empty cache) sees a working app:

1. Open Chrome DevTools → Application → Storage → Clear site data.
2. Navigate to the Pages URL.
3. Wait for the boot screen to clear (the AI model weights download on first visit — may take 30–60 s on a cold cache).
4. Type a prompt in the chat panel: `draw a 5m wall facing north`.
5. Confirm a wall appears in the 3D viewport without console errors.

If the model weights are served via the GitHub Pages CDN, the `VITE_GEMMA_AGENT_URL` env var must point to the correct HuggingFace endpoint (set in `.env.production` or the Actions workflow). A missing or wrong endpoint causes a silent fallback to CPU inference — verify in DevTools Network that the model fetch resolves.
