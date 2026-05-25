# Contributing to WEB-CAD

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

## Issues

Bug reports and feature requests: open a GitHub issue. Include browser + OS, repro steps, and what you expected vs. what happened.
