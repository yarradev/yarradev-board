# #28 — `pass.mjs`: async-dispatch-and-reconcile + bounded concurrency

**Status:** design (settled via brainstorm 2026-07-07). Spec for the plugin half of #28.
**Goal (one sentence):** replace the conductor's blocking per-card dispatch loop with a single `pass.mjs` script that reconciles landed verdicts and fans out up to K concurrent dispatches per pass, recovering long-subagent verdicts (re-CLAIM at verdict time) and dissolving #27's recovery gap.

## Architecture
`pass.mjs` is the whole pass. Each `/loop` invocation runs `node $S/pass.mjs`, which does two things and yields (non-blocking, /loop-driven):

1. **Reconcile** — scan the dispatch manifest for `done` verdicts not yet processed (from this pass *and* still-running dispatches from prior passes). For each: re-CLAIM (fresh gen — sidesteps the stale gen from lease-TTL expiry), route the verdict to the right act script, post, CLEAR_LEASE, mark consumed.
2. **Dispatch** — for up to K actionable cards (deps resolved, not in-flight): CLAIM + `build-prompt.mjs` + fire-and-forget `yarradev-dispatch` (records a `pending` manifest entry). No waiting.

The conductor (SKILL.md) shrinks to: "run `pass.mjs` each loop." All routing moves from prose into deterministic, testable code, reusing the existing act scripts — `pass.mjs` does not re-implement any act-posting; it *calls* `claim/move/reject/link-pr/push/advice/veto/hold/note/escalate/create/clear-lease` via `spawnSync` and parses their `{ok,status,outcome,blocked_by?,...}` JSON lines.

## Why this shape
- **Reuses tested scripts** — the act logic stays in the scripts that already have unit tests; `pass.mjs` ports only the *routing* (verdict → which script + args). Much less code, much less risk than re-implementing acts.
- **Non-blocking** — `/loop` interval drives cadence; a slow subagent doesn't gate the pass (it reconciles when it lands).
- **Recovery** — re-CLAIM at verdict time means a verdict that landed past lease-TTL still posts (the gen-bump no longer strands it). This is the fix #27's manifest-dedup couldn't do alone.
- **Daemon-precursor** — the reconcile/dispatch split IS the daemon's core; `pass.mjs` is the same logic as a per-pass script.

## Components
- `scripts/pass.mjs` — the orchestrator (CLI: `node $S/pass.mjs`). Internally:
  - `reconcileVerdicts(...)` — for each unconsumed `done` manifest entry: read the verdict file, parse last fenced JSON, re-CLAIM, route (see routing table), CLEAR_LEASE, mark consumed (a consumed-ledger append, mirroring the manifest's append-only style).
  - `dispatchNew(...)` — list-ready (filter deps_resolved via #32 + in-flight via #27), take up to K from the top epic, CLAIM + build-prompt + `yarradev-dispatch` (fire-and-forget).
  - `routeVerdict(...)` — the verdict→act state machine (full parity, below).
- `scripts/vendor/core.mjs` — unchanged (acts still posted by the existing scripts).
- `SKILL.md` — the per-pass procedure collapses to "run `pass.mjs`"; the old step 2/3 prose becomes the reference spec for `routeVerdict` parity (kept as a doc appendix, not the live loop).

## Routing parity (the contract — `routeVerdict` must match SKILL.md step 2/3 exactly)
Verdict status → script (posted under the re-CLAIMed gen for the card's current state):
- **worker advance** → `move.mjs <id> <gen> <to> <role>` + `note.mjs` if summary/evidence (#18).
- **worker reject** (carries `to`) → `reject.mjs <id> <gen> <to> <role>`.
- **submitted** → `link-pr.mjs` (first) / `push.mjs` (respawn) by the card's kind; then `reattach-ci.mjs` (#21).
- **analyst decomposed** → per child `create.mjs --parent` (+ `--depends-on` if set, #32), then `move.mjs <epic> <gen> <to> analyst`.
- **question / error / no-parse** → `escalate.mjs` / log + retry.
- **advisor verdict** (advice/clean → `advice.mjs --role`; veto/hold → `veto.mjs`/`hold.mjs`; reject → `reject.mjs` with conductor-derived backward edge) — incl. the `spawn[]` sub-clause (`fingerprint.mjs` + `create.mjs` + `note.mjs`, capped 20).
- **422 `blocked_by ⊇ advisor_clear`** on a MOVE → dispatch the stage's advisor **async** (fire-and-forget; its verdict reconciles next pass, then the MOVE retries). This is the async reshape of SKILL.md's same-pass inline advisor — no longer same-pass.
- every branch → `clear-lease.mjs`.

## Concurrency model
- `K = pace.maxCardsPerPass` (raise default later; start validating with K≥1). Bounded by subscription caps (a follow-up detects 429/cap and backs off — out of V1 scope).
- **Epic-bounded fan-out**: dispatch from the top-priority epic's ready cards first (preserves the "finish one epic before the next" focus discipline + reduces cross-area overlap); cross-epic only if the top epic has fewer than K ready.
- **Per-card worktree isolation** — dev/releaser already get `--worktree` from `yarradev-dispatch`; nothing new.
- **Filters reused**: `deps_resolved` (#32) and in-flight pending (#27) skip in `list-ready`.

## Error handling
- Re-CLAIM fences (409 — card moved on / someone else claimed) → the verdict is stale; log + mark consumed + skip (don't retry — the card state changed under us).
- Dispatch failure (yarradev-dispatch non-zero / no pending written) → CLEAR_LEASE, retry next pass (manifest-dedup prevents a duplicate while the prior is in-flight).
- Any act script non-committed (422 gate_blocked) → CLEAR_LEASE; `decide` re-derives next pass (same as today).
- Best-effort throughout: a single card's failure never aborts the pass (other cards + other reconciliations proceed).

## Testing
- **Routing parity** — a table-driven test: for each verdict shape (advance/reject/submitted/decomposed/question/error + each advisor verdict + spawn + the 422-advisor_clear case), assert `routeVerdict` calls exactly the expected scripts with the expected args (script calls mocked; no real board/gh). This is the load-bearing test — it pins parity with SKILL.md.
- **Reconcile** — a done manifest entry → re-CLAIM + route + clear + mark-consumed; a pending (no done) → skipped; already-consumed → skipped.
- **Dispatch** — K bound respected; epic-bounding (top epic first); deps_resolved=false + in-flight skipped.
- **Recovery** — a verdict whose dispatch predates a lease-TTL gen-bump still posts (re-CLAIM yields fresh gen).
- `npm test` stays green; existing tests untouched.

## Non-goals (V1)
- Server-side `deps_resolved` gate (board-side, separate — #32's enforcement stays plugin-side).
- Subscription-cap-aware K backoff (detect 429/cap → lower K). Follow-up.
- The daemon itself (A3 — `pass.mjs` is its per-pass precursor, not the long-running component).
- Crossing epic boundaries for concurrency beyond the top epic's ready set (policy knob, B4).

## Open questions resolved by this spec
- Pass model: non-blocking, /loop-driven (Approach 1). ✓
- Routing scope: full parity. ✓
- Where the loop lives: per-pass script, conductor → thin wrapper. ✓
- Advisor inline → async (multi-pass) reshape. ✓ (called out above)
