# Plan — `pass.mjs` async-dispatch-and-reconcile (#28)

**Feature:** `scripts/pass.mjs` — per-pass orchestrator (reconcile landed verdicts + fan out ≤K concurrent dispatches). Spec: `docs/superpowers/specs/2026-07-07-pass-mjs-async-reconcile-design.md`.
**Goal:** move the conductor's blocking per-card loop into one non-blocking script that recovers long-subagent verdicts and enables bounded concurrency.
**Architecture:** `pass.mjs` calls existing act scripts via `spawnSync` (no act re-implementation); reconcile phase (done manifest entries → re-CLAIM → route → clear → consume) + dispatch phase (≤K new: CLAIM → build-prompt → fire-and-forget dispatch).
**Tech stack:** Node ESM, zero deps; `node:child_process.spawnSync` to call sibling scripts + `yarradev-dispatch`; `node:test` + `node:assert/strict`.
**Global constraints:** reuses `scripts/*.mjs` act logic verbatim (no re-impl); routing parity with SKILL.md step 2/3 pinned by table-driven tests; best-effort (one card's failure never aborts the pass); non-blocking (no in-pass wait for verdicts); `K = pace.maxCardsPerPass`.

## Tasks (each: test-first, no placeholders, commit)

### Task 1 — skeleton + reconcile core
- `scripts/pass.mjs`: CLI guard; imports. `reconcileVerdicts({ manifestPath, consumedPath, now, run /*(args)=>{code,stdout,stderr}*/, getCard, post })`.
  - Parse manifest (reuse the JSONL walk from `in-flight.mjs`); pair pending/done by `verdictPath`; for each `done` not in the consumed ledger: read verdict file (`run(["cat", verdictPath])` or `readFileSync`), parse last fenced ```json, re-CLAIM (`run claim.mjs`), hand to `routeVerdict` (stub: logs), CLEAR_LEASE, append verdictPath to consumed ledger.
  - Consumed ledger: `~/.local/share/claude-bg/dispatch-consumed.jsonl` (append verdictPaths).
- Export `nextUnconsumedDone(manifestContent, consumedContent)` (pure) for testing.
- **Tests** (`test/pass-reconcile.test.mjs`): done+unconsumed → processed; pending (no done) → skipped; already-consumed → skipped; malformed lines skipped.

### Task 2 — `routeVerdict` full parity (the contract)
- Implement the routing table (spec §Routing parity). `routeVerdict({ verdict, card, gen, run })` returns the list of script-invocations it performed; assertions are over those (scripts mocked via `run`).
  - worker: advance→move(+note), reject→reject, submitted→link-pr/push+reattach-ci, decomposed→create×N+move, question/error→escalate/log.
  - advisor: advice/clean→advice --role, veto/hold→veto/hold, reject→reject(conductor-derived edge); `spawn[]`→fingerprint+create+note (cap 20).
  - 422 `blocked_by ⊇ advisor_clear` on a MOVE → dispatch advisor **async** (record pending; reconcile next pass) — NOT same-pass.
- **Tests** (`test/pass-routing.test.mjs`): table-driven — one case per verdict shape asserting exact script calls + args (mocked `run`); covers spawn + the 422-advisor async case.

### Task 3 — dispatch phase (concurrency)
- `dispatchNew({ cards, K, epicOf, run, dispatch })`: take ≤K from the top epic's ready cards (epic-bounding); for each: CLAIM → `build-prompt.mjs` → fire-and-forget `yarradev-dispatch` (returns verdictPath; records pending). Skip on CLAIM 409.
- `pass.mjs` CLI body: `list-ready` (spawnSync) → filter (deps/in-flight already applied in-list-ready) → `dispatchNew` over the non-dispatch kinds too (advance/promote/escalate route synchronously via `routeVerdict` with the snapshot's gen — no dispatch).
- **Tests**: K bound; epic-bounding (top epic first, cross-epic only if <K ready); CLAIM 409 → skip.

### Task 4 — wire SKILL.md + ship
- SKILL.md per-pass procedure → "run `node $S/pass.mjs`" (keep the old step 2/3 prose as a collapsed "routing reference" appendix for parity auditing). Note `maxCardsPerPass` now bounds concurrency.
- Bump `plugin.json` → 0.9.0 (minor — new conductor model). `npm test` green. PR + merge, closes #28.

## Self-review checklist (before commit)
- [ ] No TODO/TBD/placeholders; every routing branch has a parity test.
- [ ] `routeVerdict` calls only existing scripts (no act logic duplicated).
- [ ] Best-effort: a thrown error in one card's reconcile/dispatch is caught + logged, doesn't abort the pass.
- [ ] Non-blocking: no `dispatch-and-wait` in the dispatch path (fire-and-forget `yarradev-dispatch`).
- [ ] Existing tests untouched; `npm test` green.

## Execution
Inline, task-by-task, test-first, commit per task. Final: full suite + ship.
