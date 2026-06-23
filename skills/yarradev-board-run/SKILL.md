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
  `board.example.json` and edit. It holds **no secret**.
- Board bearer token: the **`YDB_TOKEN`** env var (e.g. `export YDB_TOKEN=orch1.s3cret`). Never put
  the token in config, in a prompt, or in a log line.

## Per-pass procedure (one /loop invocation)
Let `S=${CLAUDE_PLUGIN_ROOT}/skills/yarradev-board-run/scripts`.

1. **List ready cards:** `node $S/list-ready.mjs` → one JSON line per workable card:
   `{ "id", "state", "role", "to", "current_gen" }`. (Terminal/blocked/leased/unknown cards are
   skipped and logged to stderr.)
2. **For each ready card, sequentially, up to `pace.maxCardsPerPass` (default 1):**
   1. **CLAIM:** `node $S/claim.mjs <id> <role> <pace.claimTtlS>` → `{ ok, gen, status, outcome }`.
      - `ok:false` (409 fenced / non-202): another owner holds it — log `claim-failed`, **skip** this card.
      - `ok:true`: keep **`gen`** (the granted lease generation) — thread it **verbatim** into the MOVE and CLEAR_LEASE.
   2. **DISPATCH one subagent** via the **Agent tool**, `subagent_type: "yarradev-board:<role>"`
      (`designer` | `developer` | `tester`). In the prompt pass the spawn inputs:
      `{ doName, cardId: <id>, state, to, role }` + the card's title/intent — and, for the **tester**,
      the **developer's branch** (from the dev verdict's `evidence`). **For `role == developer` set
      `isolation: "worktree"`** (it mutates files). The subagent does the real work and **returns a
      fenced ` ```json ` verdict block**; it never touches the board.
   3. **PARSE** the subagent's return — take the **last** fenced ` ```json ` block →
      `{ status, to, summary, evidence }`:
      - `status:"advance"` → `node $S/move.mjs <id> <gen> <to>` (`to` must equal the lifecycle next state).
      - `status:"reject"` → `node $S/move.mjs <id> <gen> <verdict.to>` (a backward edge, e.g. test→dev).
      - `status:"question"` / `"error"` / **no parseable block** → post nothing; log it (Slice 2: escalate to a human).
   4. **CLEAR_LEASE — always:** `node $S/clear-lease.mjs <id> <gen>` in **every** branch above
      (advance, reject, question, error) so a crashed pass never strands a lease.
   5. Log a one-line outcome. Carry useful `evidence` (e.g. the developer's branch) forward into the
      next stage's card context.
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
- **You never do role work and never hand the token to a subagent.** Subagents return verdicts; you
  post acts under the single orchestrator identity.

## Failure map
| Step | Failure | Do |
|---|---|---|
| CLAIM | 409 fenced (stale gen / already leased) | log `claim-failed`, skip card; next pass re-reconciles |
| Dispatch | subagent error / timeout / no JSON block | post nothing; **CLEAR_LEASE**; retry next pass |
| MOVE | 409 fenced (lease/TTL expired mid-work) | **CLEAR_LEASE**; redo next pass |
| MOVE | 422 gate_blocked / bad_act | **CLEAR_LEASE**; log (Slice 2: escalate) |
| CLEAR_LEASE | any | best-effort; the lease expires at its TTL anyway |

## Verify
Seed one card in `spec`, `export YDB_TOKEN=…`, then run `/loop 30s /yarradev-board:yarradev-board-run`.
Watch it move spec→dev (designer) → dev→test (developer) → test→done (tester). Confirm
`node $S/list-ready.mjs` goes quiet and the card reads `state: done`.
