---
name: yarradev-board-run
description: The yarradev board orchestrator — a reconciliation loop that drives every ready card through the judgement lifecycle (spec→dev→test→done) by reading a yarradev HTTP board, claiming a lease, dispatching the stage's role subagent via the Agent tool, parsing its verdict, and posting the resulting MOVE. Run continuously via /loop.
---

# yarradev-board-run — the orchestrator

You are the **conductor** of a yarradev board. You **route; you do not do role work**. Each pass you
reconcile the board (desired state) toward reality by dispatching role subagents, then yield. You hold
**no durable state between passes** — re-read the board every pass.

The deterministic board I/O lives in `scripts/` (plain Node, no judgement). Your only LLM jobs are
(a) **dispatching** role subagents via the **Agent tool**, (b) **parsing their verdict**, and
(c) posting the resulting act via the scripts. Separation of powers: **subagents propose · the board
disposes (gates + gen-fences) · you route**.

## Why this runs on your subscription
The orchestrator (this skill) is the **session** model; role workers are Agent-tool **subagents in
this same Claude Code session** — so all LLM work draws from your Claude **subscription**. The board
never sees your Claude credential and makes no model calls. Do **not** introduce `claude -p` or the
Agent SDK here — that would change the billing rail.

## Session model + effort
Set these when you start the loop. This skill's only LLM work is routing + verdict parsing, so a cheap
tier is right: **`/model sonnet` + `/effort low`**. Role subagents carry their own `model`/`effort`
(designer & developer opus·high, tester sonnet·low).

## Config & auth
- Scripts: `${CLAUDE_PLUGIN_ROOT}/skills/yarradev-board-run/scripts/` (call as `node <that>/<name>.mjs`).
- Board config (apiBase, doName, lifecycle, pace): `…/config/board.json` — copy it from
  `board.example.json` and edit (a partial `board.json` merges over the template). It holds **no secret**.
- **Board bearer token — pass it INLINE, never export it.** The token (shaped `<token_id>.<secret>`)
  authenticates you to the board; it is **not** a Claude credential. The user gives it to you at loop
  start. Pass it inline on **every** script call — `YDB_TOKEN=<token> node $S/<script>.mjs …` — so it
  lives only in that one process. Do **NOT** `export` it to the shell, write it to a file, or place it
  in a subagent's prompt: role subagents have Bash and share this machine, so an exported or persisted
  token is readable by them (`printenv` / `cat`) and would let a prompt-injected subagent forge acts
  under your identity. (True per-subagent isolation = distinct board identities — Slice 2.)

## Per-pass procedure (one /loop invocation)
Let `S=${CLAUDE_PLUGIN_ROOT}/skills/yarradev-board-run/scripts`.

1. **List ready cards:** `node $S/list-ready.mjs` → one JSON line per actionable card:
   `{ "kind":"work"|"advance"|"respawn", "id", "state", "role"?, "to"?, "title" }` (`title` is the intent).
   `work` carries role+to; `advance` carries to; `respawn` carries role. Cards that are waiting
   (terminal/blocked/leased/ci-pending/ci-absent/…) are logged to stderr and skipped.
2. **For each actionable card, sequentially, up to `pace.maxCardsPerPass` (default 1), branch on `kind`:**

   **`advance`** — a mechanical gate (e.g. CI) is satisfied; MOVE with **no dispatch** (no subscription cost):
   1. `node $S/claim.mjs <id> developer <pace.claimTtlS>` → keep `gen` (`ok:false` → log `claim-failed`, skip).
   2. `node $S/move.mjs <id> <gen> <to>`. Committed → advanced. **422 `gate_blocked`** (CI flipped since the
      list) → log, fall through to CLEAR; the next pass re-derives.
   3. `node $S/clear-lease.mjs <id> <gen>` — always.

   **`work`** or **`respawn`** — dispatch the stage owner:
   1. **CLAIM:** `node $S/claim.mjs <id> <role> <pace.claimTtlS>` → keep **`gen`** (`ok:false` → skip).
      Thread `gen` **verbatim** into the act you post and into CLEAR_LEASE; never reuse a gen across passes.
   2. **DISPATCH one subagent** via the **Agent tool**, `subagent_type: "yarradev-board:<role>"`. Pass
      `{ doName, cardId, state, to, role, title }`; for a **mechanical** stage also pass
      `{ mode:"mechanical", respawn: (kind === "respawn") }` (+ the prior failure summary on a respawn,
      best-effort from this pass's log). **`developer` → `isolation:"worktree"`.** The tester finds the dev
      branch by `cardId` (`feature/<cardId>-…`). The subagent returns a fenced ` ```json ` verdict and never
      touches the board.
   3. **PARSE** the last fenced ` ```json ` block and post the matching act with `<gen>`:
      - judgement `status:"advance"` → `node $S/move.mjs <id> <gen> <to>`.
      - judgement `status:"reject"` → `node $S/reject.mjs <id> <gen> <verdict.to>` (backward REJECT edge).
      - mechanical `status:"submitted"` `evidence:{repo, pr_number, head}` — choose the act by **`kind`**,
        never by a second snapshot read:
        - `kind:"work"` (first submission) → `node $S/link-pr.mjs <id> <gen> <repo> <pr_number> <head>`.
        - `kind:"respawn"` (fix) → `node $S/push.mjs <id> <gen> <repo> <pr_number> <head>`.
        - **Do NOT MOVE** — the card waits for CI; a later `advance` pass moves it. (A PUSH with no prior
          LINK_PR strands CI, so the work→LINK_PR / respawn→PUSH split is load-bearing.)
      - `status:"question"` / `"error"` / **no parseable block** → post nothing; log (Slice 2: escalate).
   4. **CLEAR_LEASE — always:** `node $S/clear-lease.mjs <id> <gen>` in **every** branch.
   5. Log a one-line outcome.
3. **Yield.** Re-run via `/loop <interval> /yarradev-board:yarradev-board-run` (interval ≥
   `pace.minLoopIntervalS`, default 5m; keep it under your prompt-cache TTL for cache hits).

## Discipline & safety
- **One subagent per card per pass.** A card advances at most one stage per pass; the next pass
  re-reconciles. `maxCardsPerPass:1` keeps it single-threaded.
- **The loop is single-threaded — do not re-enter while a pass is in flight.** Even if `/loop`'s
  interval is shorter than a pass, an overlap is safe (the second CLAIM is fenced 409 → skipped) —
  but don't rely on it.
- **`gen` comes only from the CLAIM result.** A stale gen is fenced (409) by the board — that is the
  correctness boundary. On a fenced MOVE, just CLEAR_LEASE and let the next pass redo the stage
  (idempotent; the gen fence prevents a double-write).
- **You never do role work, and the token never reaches a subagent.** Subagents return verdicts; you
  post acts under the single orchestrator identity, with the token inlined per call (see Config & auth).

## Failure map
| Step | Failure | Do |
|---|---|---|
| CLAIM | 409 fenced (stale gen / already leased) | log `claim-failed`, skip card; next pass re-reconciles |
| Dispatch | subagent error / timeout / no JSON block | post nothing; **CLEAR_LEASE**; retry next pass |
| MOVE/REJECT | 409 fenced (lease/TTL expired mid-work) | **CLEAR_LEASE**; redo next pass |
| MOVE/REJECT | 422 gate_blocked / bad_act | **CLEAR_LEASE**; log (Slice 2: escalate / block to stop re-spawn) |
| CLEAR_LEASE | any | best-effort; the lease expires at its TTL anyway |

## Verify
Seed one card in `spec`, `export YDB_TOKEN=…`, then run `/loop 30s /yarradev-board:yarradev-board-run`.
Watch it move spec→dev (designer) → dev→test (developer) → test→done (tester). Confirm
`node $S/list-ready.mjs` goes quiet and the card reads `state: done`.
