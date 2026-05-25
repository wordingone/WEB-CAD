# Failure Classes — gemma-architect

Recurring bug shapes from the 24-codex-bug preservation arc (B1–B22+) and from the cross-cutting friction surfaced via Leo's insights and Eli's debugging history. Read this BEFORE writing code that touches schema, dispatch, samples, or the chat path.

---

## C1 — Tool-call envelope drift (B1+B2)

**Symptom.** Gemma 4 emits `<tool_call>{"command":"VerbName","parameters":{...},"metadata":{"source":"agent"}}</tool_call>` but the harness drops the dispatch silently because it's parsing a different format.

**Verification.** `web/src/agent/agent-harness.ts` tool-call-tag regex must match `<tool_call>...{...}</tool_call>` and the system prompt must explicitly instruct the model to use that envelope.

**Recovery.** Regex fix + system prompt update + a unit test that feeds a sample envelope through and asserts the verb/args extraction.

## C2 — Schema-validator vs handler-signature mismatch

**Symptom.** Handler reads `args.x` (scalar) but schema declares `target` and `vector` as required. Model emits `{vector: [5,0,0]}` and dispatch fails validation. Or model emits `{x: 5}` (scalar) and dispatch fails because `vector` is required.

**Verification.** When changing a handler in `web/src/main.ts` OR a schema entry in `web/src/commands/spatial-api.yaml`, grep for the verb name in BOTH files. Confirm the schema's required/optional flags match what the handler actually reads. Run `bun test web/test/command-session.test.ts`.

**Recovery.** Mark all alternative arg forms as `optional` in the schema; handler picks whichever form the model emitted. Worked example: SdMove accepting `target`, `vector`, AND scalar `x`/`y`/`z` (PRs #89, #91 in the codex arc).

## C3 — DSL-vs-NL routing confusion

**Symptom.** Test fires `cdp prompt "draw a wall"` expecting NL agent dispatch; the prompt routes to `#console-input` (DSL), `compileDsl` rejects "draw" as unknown verb, NL path never exercised.

**Verification.** `cdp prompt` targets DSL console. `cdp chat` targets NL agent input. Pick the right subcommand for the path you're testing.

**Recovery.** Use `cdp chat <text>` for NL agent verification; reserve `cdp prompt` for DSL console testing.

## C4 — Sub-object handle data loss (B20–B22)

**Symptom.** Line / polyline / spline drawn via tool, but Gumball doesn't show sub-object handles when selected. `userData.controlPoints` is missing.

**Verification.** Handler at `web/src/main.ts` for SdLine / SdPolyline / SdSpline / curve creator must set `obj.userData.controlPoints = [...]` BEFORE returning the mesh.

**Recovery.** Graft `controlPoints` onto `userData`. Test by creating, selecting, opening Gumball — sub-object handles should appear at each control point.

## C5 — userData.kind discrimination (B17)

**Symptom.** Dispatched object has `userData.kind = "brep"` or `"mesh"` (engine-internal) instead of `"rectangle"` / `"circle"` / `"line"` (semantic). Downstream code that filters by `kind` misclassifies.

**Verification.** Every creator handler sets `userData.kind` to the SEMANTIC verb suffix ("rectangle" not "brep"), regardless of internal geometry type.

## C6 — Centroid-anchored gumball (B15)

**Symptom.** Drawn object has world-origin position; gumball appears at (0,0,0) instead of object centroid. Inconsistent with native Rhino tooling.

**Verification.** Every `buildRect` / `Circle` / `Line` / `Polyline` / `Curve` / `Point` handler in `web/src/viewer/create-mode.ts` calls `mesh.position.set(cx, cy, 0)` after computing centroid.

## C7 — Auto-return-to-Select after create (B18)

**Symptom.** After drawing completes, palette stays on the Line tool; user has to manually click Select.

**Verification.** Every create-completion path calls `dispatchSync("setActiveTool", { toolId: "select" })` after the mesh is added to the scene.

## C8 — `@ts-ignore` as runtime-failure mask

**Symptom.** Source uses `pipeline("image-text-to-text", ...)` from transformers.js. TS rejects (`'image-text-to-text'` not in `PipelineType`). Author adds `@ts-ignore`. Runtime fails: `Unsupported pipeline: image-text-to-text. Must be one of [...]`.

**Verification.** When TS rejects a transformers.js / external-API call, that's often the runtime telling you the call isn't supported. Before `@ts-ignore`-ing, verify in browser console with DevTools open that the path actually works at runtime.

**Recovery.** Switch to the supported runtime path (e.g., `Gemma4ForConditionalGeneration.from_pretrained` + `AutoProcessor.from_pretrained` direct, not the high-level `pipeline()`).

## C9 — Field-name drift (`input_tokens_details` vs `prompt_tokens_details`)

**Symptom.** Code reads `usage.input_tokens_details.cache_creation_input_tokens` from API response. Field is actually `usage.prompt_tokens_details.cached_tokens` (or vice versa). Empty-or-zero captures slip through unit tests because mocked usage objects are hand-rolled to match the wrong field.

**Verification.** Before writing code that reads any field from an external API response, fetch ONE real response, dump its keys, confirm the exact field path. Don't assume from memory.

**Recovery.** Fix the field path. Re-test against a real response, not a mock.

## C10 — Branch swap in serving worktree

**Symptom.** Dev server is running from a working tree at `localhost:5175` serving Jun's view. Author runs `git checkout pr-N` in that same tree to verify the PR. Vite HMR picks up the swap; Jun sees the wrong branch's code in his browser.

**Verification.** NEVER `git checkout` (without `--`) in a tree serving an active dev server. Use `git show <ref>:<path>` for read-only inspection or `git worktree add` for a separate checkout.

**Recovery.** `git checkout <previous-branch>` to restore. Damage is done — Jun has already seen the wrong bytes.

## C11 — Port redirect

**Symptom.** PR's code lives at `:5174` (Eli's clone) but Jun is testing at `:5175`. Mail/PR comment says "Jun, switch to port 5174." Jun: "stop trying or allowing changes to the port number."

**Verification.** When verifying live UI, the PR's bytes must reach Jun's existing URL. Identify the process serving Jun's port (`Get-NetTCPConnection -LocalPort 5175 -State Listen` → `Get-CimInstance Win32_Process` → working dir from `CommandLine`); confirm that dir's checkout is on the PR's branch. If it isn't, the fix is to deliver the code to that URL — never the redirect.

## C12 — Synthetic samples framed as real

**Symptom.** Bundled IFC fixtures (KIT FZK-Haus, Institute-Var-2) called "architect-authored" or "production-quality" in writeup or PR copy. They are synthetic test fixtures, generated.

**Verification.** Writeup language about samples must distinguish synthetic test fixtures from real-world architect content. Drag-drop user's own IFC is the canonical demo path; bundled samples are placeholders.

## C13 — Codex bug regression on rebase

**Symptom.** A bug in the codex catalog (B1–B22+) returns after a rebase / merge / refactor. The fix was preserved, but new code overwrote it.

**Verification.** When changing files that touched a codex bug fix (`commands/spatial-api.yaml`, `main.ts` handler block, `create-mode.ts` builders, `agent-harness.ts` envelope), grep for the bug ID in PR comments / commit messages to find prior fix; cross-check that the new code preserves it.

## C14 — `cdp` typed into wrong DOM target

**Symptom.** `cdp prompt` and `cdp chat` exist; using one for the other's purpose silently runs against the wrong DOM target and the test reports false-fail.

**Verification.** Read `web/src/chat-panel.ts:51-78` (chat compose) and `scripts/cdp.ts` (subcommand routing) before adding new browser-CLI subcommands. Each subcommand must target a unique DOM selector with documentation in the help block.

## C15 — Image dispatch dropped at adapter

**Symptom.** Image content blocks reach the adapter layer but get stripped to empty strings; model sees text-only despite image input.

**Verification.** When adding multimodal pathways, audit `contentBlockToString` (or equivalent) for the explicit image-handling branch. Image blocks must be transformed to OpenAI-compat `image_url` parts, not dropped.

(Cross-cutting with avir-cli's Finding #7. If the bug surfaces in this codebase's transformers.js path, fix here. If it traces to avir-cli's `openai-adapter.ts`, surface to Eli.)

---

## Per-class verify commands

Bash one-liners to spot-check each class against current branch. Run all via `/scan-codex` skill, or individually as needed.

| Class | Verify command |
|---|---|
| C1 | `grep -n '<tool_call>' web/src/agent/agent-harness.ts` (regex must be present) |
| C2 | `bun scripts/audit-dispatch-routing.ts` (exit 0) |
| C3 | `grep -E '"(chat\|prompt)"' scripts/cdp.ts` (both subcommands present) |
| C4 | `grep -n 'userData\.controlPoints' web/src/main.ts` (line/polyline/spline handlers all set it) |
| C5 | `grep -n 'userData\.kind' web/src/main.ts \| grep -vE '"brep"\|"mesh"'` (semantic verb suffix only) |
| C6 | `grep -n 'mesh\.position\.set' web/src/viewer/create-mode.ts` (centroid set in every builder) |
| C7 | `grep -n 'setActiveTool.*select' web/src/viewer/create-mode.ts` (auto-return after every create-completion) |
| C8 | `grep -rn '@ts-ignore\|@ts-expect-error' web/src/` (review every hit; any new addition triggers `/verify-suppression`) |
| C9 | `grep -rn 'input_tokens_details\|prompt_tokens_details' web/src/` (verify against live API response — DO NOT trust source-side string match alone) |
| C10 | manual: `git status` in any tree serving a dev server BEFORE any `git checkout`; never swap branches in a serving worktree |
| C11 | manual: when posting "verify at port N" to Jun, confirm port N is Jun's `:5175`, not your clone's port |
| C12 | `grep -nE 'architect-authored\|production-quality\|architect-curated' submission/writeup.md submission/README.md` (zero hits) |
| C13 | `git log --all --grep="codex\|B[0-9]\+" --since="3 months ago" --oneline` (cross-check current diff against historical fixes) |
| C14 | manual: read `web/src/chat-panel.ts:51-78` + `scripts/cdp.ts` subcommand routing before adding new browser-CLI subcommands |
| C15 | grep adapter image-handling: `grep -nE 'image_url\|content_block.*image' web/src/agent/` (must transform, not drop) |

## Adding new classes

When something surprising surfaces that's not a clean fit for C1–C15:

1. Append to `state/learnings.jsonl` immediately:
   ```json
   {"ts":"<ISO>","kind":"failure_class","scope":"<area>","summary":"<one-line>","artifacts":["<file:line>","<command>"]}
   ```
2. If the class is reusable and recurring-shaped (not a one-off bug): promote to a new C-row in this file. Use the next available number (C16, C17, …) with the same Symptom / Verification / Recovery sub-blocks.
3. If trace points outside this codebase: mail Eli with the class name + cite the artifact in `state/learnings.jsonl`. Don't try to fix it here.
