# #54 + #55 — Surface swallowed act failures & fix empty advisor context

**Date:** 2026-07-08
**Issues:** [#54](https://github.com/yarradev/yarradev-board/issues/54) (routeVerdict silently swallows non-advisor_clear MOVE/CREATE failures), [#55](https://github.com/yarradev/yarradev-board/issues/55) (inline advisor dispatch builds prompt with empty repo/branch/head for tester-owned stages)
**Status:** Design approved

Two independent correctness bugs in `pass.mjs`'s verdict-routing subsystem (distinct root causes, same file). Fixed on one branch, two code tasks + a docs/version task.

## Bug #54 — act failures reported as `"routed"`

`routeVerdict` (`pass.mjs`) records each `move.mjs`/`create.mjs` result into `acts[]` but only ever checks `.ok` for two special shapes (the advance branch's `advisor_clear` 422 and the reject branch's bounce budget). Every other act failure is discarded:
- **Advance branch (`:307-332`)**: `if (mv && mv.ok) {…} else if (advisor_clear) {…}` — the "any other 422/409" case falls through to `return` with **no failure signal** (`:331`).
- **Decomposed branch (`:391`)**: the advance-to-barrier `move.mjs` after CREATE is **not checked at all** — the nastiest case, since children were already minted (CREATE ok) but the epic silently never reaches the barrier stage → half-advanced inconsistent state.

`reconcileVerdicts` compounds it: `outcome: r.error ? "error" : "routed"` — since `routeVerdict` never sets an error on a swallowed act failure, every log line reads `"routed"`. Confirmed live 3×: a missing `YDB_TOKEN_ANALYST` (crashed `run()`) and a stale `to` value (normal 422), both silently reported success while cards sat stuck for multiple cycles.

### Fix (approved approach: distinct `act_failed` outcome, not throw)
1. In `routeVerdict`, introduce `let actFailed = null;`. Check `.ok` on the currently-unchecked acts:
   - Advance branch: when the MOVE is neither `ok` nor the handled `advisor_clear` case, set `actFailed = { script: "move.mjs", result: mv }`.
   - Decomposed branch: check the barrier `move.mjs` result; on `!ok`, set `actFailed` AND call `escalate.mjs` (children already minted → genuinely stuck inconsistent state that needs a loud board-side signal, not a silent retry).
   - Include `actFailed` in the returned object of these branches (default `null` elsewhere; `reconcileVerdicts` reads `r.actFailed`, undefined is falsy → unchanged for all other paths).
2. `reconcileVerdicts` outcome mapping: `outcome: r.error ? "error" : r.actFailed ? "act_failed" : "routed"`, and log the `act_failed` line distinctly (include the failing script + the board's reason/outcome) so it's visible in pass stdout.

Rationale for distinct outcome over throwing: a board 422 (act rejected) is semantically different from a reconcile-machinery crash (`error`); a distinct outcome preserves the `acts[]` detail and keeps the two diagnosable apart.

**Not in scope:** auto-retry / auto-fix of the failed act (the existing CLEAR_LEASE + decide-re-derive recovery still runs). This bug is about *observability* — making a silently-failed advance distinguishable from a real one.

## Bug #55 — advisor prompt built from empty `ctx.repo/branch/head`

`makeBuildAdvisorPrompt(lifecycle, doName)` (`pass.mjs:846`) writes `repo/branch/head` straight from `ctx`. For the async-reshape path (advance 422 `advisor_clear`, `:324`), `ctx` is the **original owner-dispatch's** recorded context. For tester-owned judgement stages (`test`→`done`), the tester's dispatch context never records `repo/branch/head` (testers self-discover their branch by `cardId`), so the advisor (e.g. `code-reviewer`) gets an empty diff target. Confirmed live on card `1db6b7b4`.

### Data availability (investigated)
- `getEnriched(id)` exposes **`linked_head_sha`** (the PR head SHA) but NOT `repo`/`branch`/`pr_number` — those live in the server-side `pr_link` row, sourced from the worker's verdict evidence at submission (`core.mjs:56`, `pass.mjs:359`).
- `head` (the review target SHA) is the load-bearing field; `branch` the advisor self-discovers by `cardId` (as the tester does); `repo` is not needed for a local SHA diff (advisor runs in the repo cwd).

### Fix (approved: fetch head, self-discover branch)
- `makeBuildAdvisorPrompt(lifecycle, doName, getCard)` — inject `getCard` (the `getEnriched` already available in `reconcileVerdicts`). Return an **async** builder (`routeVerdict` already `await`s `buildAdvisorPrompt`).
- In the builder: `const card = await getCard(ctx.id); const head = card?.linked_head_sha ?? ctx.head ?? "";`. Populate `head` from that.
- Prompt text: instruct the advisor to self-discover its branch by `cardId` (mirror the tester's `git branch -r --list 'origin/feature/<cardId>-*'`), rather than relying on a `branch:` line. Keep `repo`/`branch` lines as `ctx.* ?? ""` fallbacks (defensive; empty is fine now that head + self-discovery cover the real need).
- Wire `getCard` into `makeBuildAdvisorPrompt(...)` at its construction site in `main()`.

## Components / files

- `skills/yarradev-run/scripts/pass.mjs` — `routeVerdict` (#54), `reconcileVerdicts` outcome mapping (#54), `makeBuildAdvisorPrompt` + its construction site (#55).
- `skills/yarradev-run/SKILL.md` — failure-map: document the new `act_failed` reconcile outcome; note the advisor prompt sources `head` from the linked PR + self-discovers branch.
- `.claude-plugin/plugin.json` — patch bump (bugfix) → `0.14.1`.

## Testing

- **#54:** `routeVerdict` unit tests (injected `run`): an advance MOVE returning a non-`ok`, non-`advisor_clear` result → result carries `actFailed`; a `decomposed` verdict whose barrier MOVE returns `!ok` → `actFailed` set AND an `escalate.mjs` act recorded. `reconcileVerdicts` maps an `actFailed` route result to `outcome:"act_failed"`. Confirm the existing `advisor_clear` and happy-path advance still return `advisorClear422`/no actFailed (no regression).
- **#55:** `makeBuildAdvisorPrompt` with an injected `getCard` returning `{ linked_head_sha }` → the built prompt's `head:` line carries that SHA; with `getCard` returning `null` → falls back to `ctx.head ?? ""` (no throw). Async signature exercised.
- Full suite stays green.

## Version

Patch bump → **0.14.1** (two bug fixes).
