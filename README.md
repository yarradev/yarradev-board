# yarradev-board

A Claude Code plugin: a **reconciliation-loop orchestrator** that drives a **yarradev HTTP board**
(the Cloudflare Durable Object board in `yarradev-platform`) and dispatches **role subagents**
(designer → developer → tester) via the **Agent tool** — running on **your own Claude subscription**.

You install the plugin, point it at your board, and run `/loop … /yarradev-board:yarradev-board-run`.
Each pass it claims a ready card, dispatches the stage's role subagent to do the real work, and posts
the resulting transition back to the board.

## How it consumes your subscription (and stays ToS-clean)

The orchestrator skill is the **session model**; role workers are Agent-tool **subagents in the same
Claude Code session**. So all LLM work draws from **your Claude Pro/Max subscription** — not API
credits. The board (a separate SaaS) **never receives your Claude credential and makes no model
calls**; it only stores the work log and enforces the state machine. This plugin does **not** use
`claude -p` or the Claude Agent SDK.

> `YDB_TOKEN` is your **board** bearer — **not** a Claude credential. Don't `export` it into your
> shell profile and don't commit it: the orchestrator inlines it per board call so role subagents
> (which have Bash and share the machine) never see it. Running the automated tests is the exception —
> there are no subagents there, so inlining it on the `npm test` line is fine.

## Install

```
/plugin marketplace add yarrasys/claude-plugins      # (when published)
/plugin install yarradev-board@yarrasys
```

Or load locally during development by enabling the plugin from this checkout.

## Configure

1. Copy the config template and edit it (no secret goes here):
   ```
   cp skills/yarradev-board-run/config/board.example.json skills/yarradev-board-run/config/board.json
   # set apiBase, doName, and the judgement lifecycle / pace
   ```
2. Have your board token ready (shaped `<token_id>.<secret>`). Give it to the orchestrator at loop
   start; it is passed **inline per board call** (`YDB_TOKEN=<token> node …`) and **never exported
   persistently** — role subagents share the machine and could read an exported token.

`config/board.json` is gitignored. Defaults (`board.example.json`): `apiBase http://localhost:8802`,
`doName acme:flow`, lifecycle `spec→dev→test→done`, pace `{ maxCardsPerPass:1, claimTtlS:1800,
minLoopIntervalS:300 }`.

## Run

```
/model sonnet      # the orchestrator's own LLM work is just routing — keep it cheap
/effort low
/loop 5m /yarradev-board:yarradev-board-run
```

## Local end-to-end demo (against the platform stack)

1. **Boot the platform stack** (in the `yarradev-platform` repo): `wrangler dev` the **board** (:8801)
   then the **api** (:8802) with `--persist-to /tmp/yd-state`.
2. **Create the board + an orchestrator identity** via the admin path: `POST /boards`
   (header `x-yd-admin: local-admin`) with a machine whose transitions are the forward edges
   `spec→dev→test→done` **plus the backward edges declared as REJECT** — `{type:"REJECT",from:"test",
   to:"dev"}` and `{type:"REJECT",from:"dev",to:"spec"}` (a MOVE on a REJECT edge is rejected). Grant
   the orchestrator identity caps `CREATE / CLAIM / MOVE / REJECT / CLEAR_LEASE`. Token: `orch1.s3cret`.
3. **Seed a card:**
   `POST /boards/acme:flow/acts {"type":"CREATE","item_id":"card-1","data":{"state":"spec","title":"<intent>"}}`.
4. In the Claude Code session, give the orchestrator the board token (`orch1.s3cret`) in your launch
   message — it inlines it per call; don't `export` it — set `/model sonnet` + `/effort low`, then
   `/loop 30s /yarradev-board:yarradev-board-run`.
5. Watch: designer → MOVE spec→dev; developer (own worktree, real commit, pushes branch) → dev→test;
   tester (fetches the branch, validates) → test→done. Confirm
   `GET /boards/acme:flow/cards/card-1` → `state: done`.

## Tests

```
npm test                                    # pure decide() unit tests (offline)
YDB_IT=1 YDB_TOKEN=orch1.s3cret npm test    # also runs the live HTTP-rail test against the seeded board above
```

The live LLM dispatch (subagents doing real work) is exercised only by the demo runbook above — it
consumes your subscription in-session and can't be unit-tested. Automated tests cover the
deterministic rail (scripts + gen-fence/gate contract) only.

## Scope (Slice 1) and what's next

**This slice:** the orchestrator skill + `designer`/`developer`/`tester` agents driving the judgement
lifecycle `spec→dev→test→done` (with `REJECT` backward edges); the orchestrator holds the token and
posts `CLAIM` / `MOVE` / `REJECT` / `CLEAR_LEASE` from each subagent's returned verdict (one shared
identity). The card `title` carries intent to every role; the tester finds the developer's work by the
`cardId`-encoded branch. Persisting richer cross-stage context (the designer's plan → the developer)
is Slice 2.

**Slice 2 (next):** the CI/mechanical gate (developer opens a PR → wait for `ci_green` via the GitHub
webhook → auto-advance), `RENEW` for long jobs, the `security-advisor` VETO + human-`CLEAR`, bounce/
transition budgets, per-role board identities, multi-card concurrency, and the analyst/releaser + epic
tier.
