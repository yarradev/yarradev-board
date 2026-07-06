# yarradev

A Claude Code plugin: a **reconciliation-loop orchestrator** that drives a **yarradev HTTP board**
(the Cloudflare Durable Object board in `yarradev-platform`) and dispatches **role subagents**
(designer → developer → tester, plus a **security-advisor**, a **releaser** staging deploy, and a
**human production gate**) via the **Agent tool** — running on **your own Claude subscription**.

You install the plugin, point it at your board, and run `/loop … /yarradev:yarradev-run`.
Each pass it claims a ready card, dispatches the stage's role subagent to do the real work, and posts
the resulting transition back to the board.

> ⚠️ The HTTP board backend (the `yarradev-platform` Cloudflare service) is a **separate, not-yet-public**
> service. This plugin is the open client; until you have a board endpoint to point it at, only the
> offline `npm test` suite runs standalone. (A hosted board is on the roadmap.)

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
/plugin marketplace add yarradev/yarradev-board
/plugin install yarradev@yarradev
```

Or load locally during development by enabling the plugin from this checkout.

## Configure

1. Copy the config template and edit it (no secret goes here):
   ```
   cp skills/yarradev-run/config/board.example.json skills/yarradev-run/config/board.json
   # set apiBase, doName, and the lifecycle / pace / budgets
   ```
2. Have your board token ready (shaped `<token_id>.<secret>`). Give it to the orchestrator at loop
   start; it is passed **inline per board call** (`YDB_TOKEN=<token> node …`) and **never exported
   persistently** — role subagents share the machine and could read an exported token.

`config/board.json` is gitignored. `board.example.json` ships the **full lifecycle**
`spec→dev→test→done→staging→prod`: `spec` (judgement → designer), `dev` (mechanical **CI gate** + a
**security-advisor** watching protected paths → developer), `test` (judgement → tester), `done` (the
**releaser** runs `deploy.staging` → staging), `staging→prod` (**human GO** required), `prod` (terminal).
Defaults: `apiBase http://localhost:8802`, `doName acme:flow`, pace `{ maxCardsPerPass:1, claimTtlS:1800,
minLoopIntervalS:300 }`, budgets `{ transition_budget:50, bounce_limit:3, respawn_window_ms:60000 }`,
`deploy.staging` (your staging-deploy command; empty by default → the releaser escalates to configure it).

> The plugin lifecycle's `gate` tags (`mechanical`/`human`) are **routing hints for `decide()` only**.
> The board's real enforcement is the compiled `GateExpr` on each transition edge, and the two must
> agree (see the demo's board-machine step). If a board edge omits the gate, the act commits with no
> enforcement; if the edge is missing, the MOVE 422s with no `blocked_by`.

## Run

```
/model sonnet      # the orchestrator's own LLM work is just routing — keep it cheap
/effort low
/loop 5m /yarradev:yarradev-run
```

## Local end-to-end demo (against the platform stack)

`board.example.json` ships the full lifecycle, so this demo exercises every gate in it (judgement, CI,
advisor VETO, the releaser staging deploy, and human GO). Boot the **board** (:8801), **api** (:8802), and **webhook** (:8803) in the
`yarradev-platform` repo (`wrangler dev`, all `--persist-to /tmp/yd-state`, and
`--var GITHUB_APP_WEBHOOK_SECRET=local-whsec` on the webhook).

1. **Create the board machine** (admin `POST /boards`, header `x-yd-admin: local-admin`) to **mirror**
   the plugin lifecycle:
   - forward edges `spec→dev`, `test→done`, `done→staging`; backward edges as REJECT
     (`{type:"REJECT",from:"test",to:"dev"}`, `{type:"REJECT",from:"dev",to:"spec"}`,
     `{type:"REJECT",from:"done",to:"dev"}` for a failed staging deploy) — a MOVE on a REJECT edge is rejected;
   - the **gated** edges: `{from:"dev",to:"test",gate:{all:[{p:"ci_green"},{p:"no_open_veto"},
     {p:"no_open_hold"}]}}`, the judgement edge `{from:"done",to:"staging",gate:{p:"not_blocked"}}` (the
     releaser's verdict drives it — **not** `ci_green`, which would reuse the dev PR's rollup), and
     `{from:"staging",to:"prod",gate:{p:"human_go"}}`;
   - `terminal:["prod"]`.
2. **Identities & caps:**
   - orchestrator `orch1.s3cret` — caps `CREATE / CLAIM / MOVE / REJECT / CLEAR_LEASE / LINK_PR / PUSH /
     VETO / HOLD`;
   - a `{kind:"system",role:"github-app",act_type:"INGEST_FACT"}` cap (CI fact ingest);
   - a `clear_authority` signatory with `CLEAR_VETO` (an accountable human clears an advisor VETO/HOLD);
   - a `byKind:"human"` identity `human1.s3cret` (role `approver`) with an `{kind:"human",
     role:"approver",act_type:"HUMAN_GO"}` cap. **HUMAN_GO needs BOTH the cap grant AND a human
     identity** — an agent is denied 403, so it cannot self-approve a release.
3. **Seed CI routing** so signed checks reach the board: a CATALOG `installation` row + `repo_board`
   (`owner/repo → acme:flow`) — `wrangler d1 execute yarradev-catalog --local --persist-to /tmp/yd-state
   --command "INSERT OR IGNORE INTO repo_board ..."`.
4. **Seed a card:**
   `POST /boards/acme:flow/acts {"type":"CREATE","item_id":"card-1","data":{"state":"spec","title":"<intent>"}}`.
5. **Run the loop:** give the orchestrator `orch1.s3cret` in your launch message (it inlines it per call;
   don't `export` it), set `/model sonnet` + `/effort low`, then `/loop 30s
   /yarradev:yarradev-run`, and watch each gate:
   - **spec→dev** — designer writes the spec → MOVE.
   - **dev** (mechanical + advisor) — developer (own worktree, real commit, pushes a branch) returns
     `submitted{repo,pr_number,head}` → orchestrator `LINK_PR`s; the security-advisor reviews the diff
     against its `watch_paths` and may `VETO`/`HOLD`. A MOVE dev→test is **422** until **CI is green AND
     there is no open veto/hold**. Deliver CI: a signed `check_run{head_sha:<head>,conclusion:"success"}`
     to :8803 (`x-hub-signature-256` = HMAC-SHA256 of the body with the secret) → routed
     `installation`→`repo_board`→board → `ci_rollup=success`. Clear any advisor VETO via the
     `clear_authority` signatory (`clear-veto.mjs`). Next pass: `advance` → MOVE dev→test, **no developer
     re-spawn**. (A `conclusion:"failure"` → `respawn` → developer fixes, PUSH a new head; a later green
     `check_run` on the new head advances; a stale one on the old head is dropped.)
   - **test→done** — tester fetches the branch, validates → MOVE.
   - **done→staging** — the releaser checks out the branch in its own worktree, runs `deploy.staging`
     (idempotently), and returns `advance` → orchestrator MOVEs to `staging` (a failed deploy → `reject` to
     `dev`). Set `deploy.staging` in `board.json` to a real command; an empty command makes the releaser escalate.
   - **staging→prod** (human GO) — the orchestrator attempts `promote` each pass and logs **422 `human_go`**
     (no GO yet). Once the card reads `staging`, a human runs `node $S/human-go.mjs card-1` as
     `human1.s3cret`; the next pass's promote commits. Confirm `GET /boards/acme:flow/cards/card-1` →
     **`state: prod`**.

## Tests

```
npm test                                    # pure decide() unit tests (offline)
YDB_IT=1 YDB_TOKEN=orch1.s3cret YDB_DO_NAME=acme:flow YDB_WHSECRET=local-whsec npm test
```

The second form also runs the live HTTP-rail tests against the seeded board (LINK_PR → MOVE 422
`ci_green` → signed `check_run` → advance). The live **LLM dispatch** (subagents doing real work) is
exercised only by the demo runbook above — it consumes your subscription in-session and can't be
unit-tested. Automated tests cover the deterministic rail (scripts + gen-fence/gate contract) only.

## Scope and what's next

**Shipped** — the orchestrator skill + `designer`/`developer`/`tester` + `security-advisor` + `releaser`
agents driving the full lifecycle `spec→dev→test→done→staging→prod`:

- **judgement** stages (spec, test) — the subagent's verdict drives MOVE/REJECT (backward edges are
  REJECT; intent rides the card `title`; the tester finds the dev branch by `cardId`);
- a **mechanical CI gate** on `dev` — developer opens a PR (`LINK_PR`), the board waits for `ci_green`
  via the GitHub webhook, then auto-advances (no re-spawn); a red CI re-spawns the developer (`PUSH`),
  time-bounded by `respawn_window_ms`;
- **bounce / transition budgets** — `decide()` parks a card for a human (`escalate` via `ASK`) when the
  board's per-edge bounce budget or the global `transition_budget` is exhausted;
- a **security-advisor with VETO/HOLD** — joins `dev` when changed files match its `watch_paths`; a VETO
  blocks dev→test (board `no_open_veto` gate + a `decide` park) until a `clear_authority` signatory
  CLEARs it;
- a **releaser staging deploy** — at `done` the releaser runs the configured `deploy.staging` command in
  an isolated worktree, returns a verdict, and the orchestrator MOVEs the card to `staging` (a failed
  deploy rejects to `dev`); the releaser never touches production.
- a **human production gate** — `staging→prod` requires a `byKind:human` `HUMAN_GO` (`promote`); agents
  cannot self-approve a release;
- **per-role board identities (least privilege)** — each act is posted under the role that produced it via
  a per-role token (`YDB_TOKEN_<ROLE>`, falling back to the shared `YDB_TOKEN`), so each role is scoped to
  only the acts it may post.

The orchestrator holds **all** the per-role board tokens (inlined per call) and posts each act under the
identity of the role that produced it — from each subagent's returned verdict, **never** handing a token
to a subagent.

**Validated:** `#69` — the developer subagent now creates real GitHub PRs via `gh pr create`
(with a repo path parameter) instead of returning synthetic evidence. This card validates the
full end-to-end PR creation lifecycle.

**Next:** richer cross-stage context persistence (designer's plan → developer), `RENEW` for long jobs,
multi-card concurrency, the analyst/epic tier, and a GitHub App + dashboard for the hosted board.
