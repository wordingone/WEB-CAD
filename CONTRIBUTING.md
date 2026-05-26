# Contributing to WEB-CAD

## Dev setup

```bash
git clone https://github.com/wordingone/WEB-CAD
cd WEB-CAD
bun install
bun run web:dev         # http://localhost:5847 — hot reload
```

See [SETUP.md](SETUP.md) for full prerequisites and build/deploy steps.

## Branch conventions

- `master` is the deployed branch. All code PRs target `master`.
- Docs-only PRs may target `main`.
- Branch naming: `feat/<issue>-<slug>`, `fix/<issue>-<slug>`, `refactor/<issue>-<slug>`.

```bash
git checkout master
git checkout -b feat/123-my-feature
```

## Commit style

Conventional commits:

```
feat(scope): short description
fix(scope): short description
refactor(scope): short description
docs: short description
```

Keep the subject line under 72 chars. Reference the issue number in the commit body when relevant.

## Before opening a PR

```bash
bun run verify              # typecheck + audit stack (must exit 0)
bun scripts/audit-aliases.ts  # alias/synonym audit
bun test web/               # full test suite (0 fail)
```

See [SETUP.md](SETUP.md) for environment setup.

## Opening the PR

```bash
gh pr create --base master --title "feat(scope): ..." --body "..."
```

Always `--base master`. The GitHub default is `main` — use the flag explicitly.

After opening:

```bash
gh pr merge <N> --auto --squash --delete-branch
```

CI green → merge fires automatically.

## Test suite

```bash
bun test web/           # ~1509 tests, should report 0 fail
```

Tests live in `web/test/`. Each handler module has a corresponding `*.test.ts` file. When adding a new verb, add a test file alongside it.

## Schema changes

The spatial SDK contract lives in `web/src/commands/spatial-api.yaml`. Any change to a verb's parameters must be reflected in both:

1. The YAML schema entry (required/optional flags, types, units)
2. The handler in `web/src/handlers/` or `web/src/register-handlers.ts`

Run `bun run audit:dispatch` to verify they agree. See `docs/dev/add-a-handler.md` for the step-by-step guide.

## Codebase conventions

- No `@ts-ignore` or `as <Type>` casts without a browser-console-clean verification run. See `docs/dev/architecture.md` for the C8 failure class.
- No `scene.add()` / `scene.remove()` outside of viewer wrappers or `// audit-undo-ok` justified bypasses.
- Handler registration goes in `web/src/register-handlers.ts` (or a domain handler module under `web/src/handlers/`). DOM wiring goes in `web/src/dom-events.ts`.
- New palette tools follow the pattern in `docs/dev/add-a-palette-tool.md`.

## Adding a NURBS / geometry handler

1. Define the verb in `web/src/commands/spatial-api.yaml` — required/optional args, units, synonyms.
2. Implement the handler in `web/src/handlers/` (or `sketch.ts` for surface-producing ops).
3. Register it in `web/src/register-handlers.ts`.
4. Add a test in `web/test/your-handler.test.ts` — import `dispatchSync`, call it, check `{ ok: true, result: { created: "<kind>" } }`.
5. Run `bun run audit:dispatch` to confirm schema and handler agree.

NURBS results should store `userData.nurbsSurface` (or `nurbsCurve`) so that IFC export and the Gumball sub-object handles pick them up automatically.

## Issues

Bug reports and feature requests: open a GitHub issue. Include browser + OS, repro steps, and what you expected vs. what happened.
