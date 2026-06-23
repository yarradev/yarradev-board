---
name: yarradev-board-run
description: The yarradev board orchestrator — a reconciliation loop that drives every ready card through the lifecycle (spec→dev→test→done→prod, with mechanical CI, security-advisor, and human-GO gates) by reading a yarradev HTTP board, claiming a lease, dispatching the stage's role subagent via the Agent tool, parsing its verdict, and posting the resulting act. Run continuously via /loop.
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
- Board config (apiBase, doName, lifecycle, pace, budgets): `…/config/board.json` — copy it from
  `board.example.json` and edit (a partial `board.json` merges over the template). It holds **no secret**.
  `budgets` = `{ transition_budget, bounce_limit, respawn_window_ms, per_edge_overrides }` (thrash caps).
- **Lifecycle `gate` tags are plugin-side routing hints — not the enforcer.** A stage's `gate` only tells
  `decide()` how to route (`mechanical` → CI advance/respawn; `human` → promote; default → dispatch the
  owner for a judgement verdict). The board's REAL enforcement is the compiled `GateExpr` on each
  transition edge, and the two MUST agree: a `gate:"mechanical"` stage that also has an advisor needs its
  forward edge to declare `{all:[{p:"ci_green"},{p:"no_open_veto"},{p:"no_open_hold"}]}`; a `gate:"human"`
  stage needs `{p:"human_go"}`. If the board edge omits the gate, the act commits with **no** enforcement
  (e.g. a promote with no human GO — an authority bypass); if the edge is missing entirely, the MOVE 422s
  with no `blocked_by` and the advance/promote silently never fires.
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
   `{ "kind":"work"|"advance"|"respawn"|"promote"|"escalate", "id", "state", "role"?, "to"?, "reason"?, "title" }`.
   `work` carries role+to; `advance` carries role+to; `respawn` carries role; `promote` carries to (a
   human-gated stage); `escalate` carries reason (a budget is exhausted / CI stalled — park for a human).
   Waiting cards (terminal/blocked/leased/ci-pending/ci-absent/…) are logged to stderr and skipped.
2. **For each actionable card, sequentially, up to `pace.maxCardsPerPass` (default 1), branch on `kind`:**

   **`escalate`** — a budget is exhausted / CI is stalled; park for a human (**no CLAIM, no dispatch, no quota**):
   1. `node $S/escalate.mjs <id> "<reason>"` — opens a question via `ASK` → the board sets `blocked=true`.
   2. Log. The card is now parked; `list-ready` skips it until a human posts an `ANSWER` to resume.

   **`advance`** — a mechanical gate (e.g. CI) is satisfied; MOVE with **no dispatch** (no subscription cost):
   1. `node $S/claim.mjs <id> <role> <pace.claimTtlS>` → keep `gen` (`ok:false` → log `claim-failed`, skip).
      (`role` is the mechanical stage's owner, carried on the `advance` line — don't hardcode `developer`.)
   2. `node $S/move.mjs <id> <gen> <to>`. Committed → advanced. **422 `gate_blocked`** (CI flipped since the
      list) → log, fall through to CLEAR; the next pass re-derives.
   3. `node $S/clear-lease.mjs <id> <gen>` — always.

   **`promote`** — a human-gated stage (e.g. production); advance ONLY on an accountable human's GO.
   **No CLAIM** (the GO is gen-stamped — a CLAIM would invalidate it), no dispatch:
   1. `node $S/promote.mjs <id> <to>` — MOVEs at the card's current gen.
   2. `committed` → released to `<to>`. **422 with `blocked_by` ⊇ `human_go`** → log "awaiting human GO"
      and wait. A human (a `byKind:human` identity) runs `node $S/human-go.mjs <id>` to approve; the next
      pass's promote then commits. **Agents cannot self-approve a release.**

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
        If it returns **422 `bounce budget exhausted`** the edge has thrashed too often → run
        `node $S/escalate.mjs <id> "bounce budget: <edge>"` (park for a human) instead of re-looping.
      - mechanical `status:"submitted"` `evidence:{repo, pr_number, head}` — choose the act by **`kind`**,
        never by a second snapshot read:
        - `kind:"work"` (first submission) → `node $S/link-pr.mjs <id> <gen> <repo> <pr_number> <head>`.
        - `kind:"respawn"` (fix) → `node $S/push.mjs <id> <gen> <repo> <pr_number> <head>`.
        - **Do NOT MOVE** — the card waits for CI; a later `advance` pass moves it. (A PUSH with no prior
          LINK_PR strands CI, so the work→LINK_PR / respawn→PUSH split is load-bearing.)
        - **Advisor review** (stages with a configured advisor): after the LINK_PR/PUSH, dispatch
          `subagent_type:"yarradev-board:security-advisor"` with `{ doName, cardId, repo, branch, head,
          watch_paths }`. Parse its `{status, head, reason?}` (`reason` accompanies veto/hold/advice; the
          `clean` verdict omits it): `veto` → `node $S/veto.mjs <id> <head> "<reason>"`;
          `hold` → `node $S/hold.mjs <id> <head> "<reason>"`; `advice`/`clean` → log only. A VETO/HOLD parks
          the card (`decide` noops `veto-open`/`hold-open`, and the board's `no_open_veto`/`no_open_hold`
          gate blocks dev→test) until an accountable human runs `clear-veto.mjs` (a `clear_authority`
          signatory) — *you flag; a human signs off*.
      - `status:"question"` → `node $S/escalate.mjs <id> "<the question>"` (park for a human).
        `"error"` / **no parseable block** → post nothing; log; retry next pass.
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
| MOVE/REJECT | 422 gate_blocked / bad_act | **CLEAR_LEASE**; `decide` re-derives next pass (gate flipped → wait/respawn; budget → escalate; bounce → escalate) |
| CLEAR_LEASE | any | best-effort; the lease expires at its TTL anyway |

## Verify
Seed one card in `spec`; give the orchestrator the board token **in your launch message** — it inlines
it per call. Do **NOT** `export` it: `/loop` dispatches role subagents in this same shell, so an exported
token is inherited by every subagent (readable via `printenv`) and a prompt-injected one could forge acts
under your identity. Then run `/loop 30s /yarradev-board:yarradev-board-run`. Watch it move spec→dev
(designer) → dev→test (developer, gated on CI + any advisor) → test→done (tester) → and park at `done`
awaiting a human GO; a `byKind:human` identity runs `node $S/human-go.mjs <id>` and the next pass promotes
done→prod. Confirm `node $S/list-ready.mjs` goes quiet and the card reads `state: prod`.
