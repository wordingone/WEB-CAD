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
bun test web/           # full web test suite (~1400 tests)
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

## Worktree layout (team context)

| Path | Purpose |
|---|---|
| `B:/M/WEB-CAD/` | Read-only inspection tree |
| `B:/M/WEB-CAD-archie/` | Active feature development (Archie's worktree) |
| `B:/M/WEB-CAD-master/` | Serving tree — Vite on `:5175`, autofwd after merge |
