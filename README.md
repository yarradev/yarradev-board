# yarradev

A Claude Code plugin: a **reconciliation-loop orchestrator** that drives a **yarradev HTTP board**
(the Cloudflare Durable Object board in `yarradev-platform`) and dispatches **role subagents**
(designer → developer → tester, plus a **security-advisor**, a **releaser** staging deploy, and a
**human production gate**) via `claude -p` — running on **your own Claude subscription**.

**Supported driver — the headless `yarradev run` daemon.** Install the plugin, point it at your
board, and run:

```
kdbx run -- yarradev run
```

(or `YDB_TOKEN=… yarradev run` if you're not using kdbx). This starts a long-lived Node process —
a timer + manifest-watch loop that runs one isolated `pass.mjs` reconcile/dispatch tick at a time and
dispatches role subagents as **detached** background processes. The runner itself makes **zero model
calls** — it only claims cards, posts acts, and shells out to `claude -p`, which draws on your own
Claude auth exactly as before. See **"Headless runner (supported)"** below.

> **Legacy: in-session `/loop /yarradev:yarradev-run`.** The previous way of running this — inside an
> interactive Claude Code session via `/loop … /yarradev:yarradev-run`, using this skill's conductor
> persona directly — still works as a manual/interactive fallback, but is no longer the supported
> driver. The machine-local `yarradev-loop` bash wrapper (the thing that used to watch
> `/tmp/yarradev-epic-done` and restart the session) is **retired**. See "Run (legacy)" below.

> ⚠️ The HTTP board backend (the `yarradev-platform` Cloudflare service) is a **separate, not-yet-public**
> service. This plugin is the open client; until you have a board endpoint to point it at, only the
> offline `npm test` suite runs standalone. (A hosted board is on the roadmap.)

## How it consumes your subscription (and stays ToS-clean)

Under the headless runner, role workers are dispatched as detached `claude -p` processes (under the
in-session legacy mode, they're Agent-tool subagents in the same Claude Code session instead). Either
way, all LLM work draws from **your Claude Pro/Max subscription** — not API credits, and never through
the runner's own credential (it holds none). The board (a separate SaaS) **never receives your Claude
credential and makes no model calls**; it only stores the work log and enforces the state machine. The
runner process itself is a plain Node daemon — it never calls a model directly.

> `YDB_TOKEN` (or the per-role `YDB_TOKEN_<ROLE>` set) is your **board** bearer — **not** a Claude
> credential. Don't `export` it into your shell profile and don't commit it. Run the headless daemon via
> `kdbx run -- yarradev run` so the vault injects it into that one process only; under the legacy
> in-session mode, inline it per board call instead — role subagents share the machine and would be able
> to read an exported token. Running the automated tests is the exception — there are no subagents
> there, so inlining it on the `npm test` line is fine.

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
The **headless runner** also reads a `runner` block: `{ port:4599, passTimeout:120, debounceMs:750 }` —
see "Headless runner (supported)" below for what each field does.

> The plugin lifecycle's `gate` tags (`mechanical`/`human`) are **routing hints for `decide()` only**.
> The board's real enforcement is the compiled `GateExpr` on each transition edge, and the two must
> agree (see the demo's board-machine step). If a board edge omits the gate, the act commits with no
> enforcement; if the edge is missing, the MOVE 422s with no `blocked_by`.

## Headless runner (supported)

```
kdbx run -- yarradev run
```

This is the daemon: a timer (`pace.minLoopIntervalS`, default 5m) plus a manifest-watch (fires early,
debounced by `runner.debounceMs`, when a dispatched subagent's verdict lands) that trigger one
`pass.mjs` reconcile/dispatch tick at a time — never overlapping (a tick requested while one is running
just re-runs once the current one finishes). Each tick is a short-lived, isolated Node subprocess: it
reconciles any landed verdicts (posts the resulting acts), then dispatches up to `pace.maxCardsPerPass`
new role subagents as **detached background processes**, then exits. There is no accumulated
context/session state to manage between ticks — unlike the old in-session `/loop`, there is nothing to
periodically clear.

- **Detached agents survive a runner restart.** A dispatched `claude -p` subagent is spawned detached
  (unref'd / backgrounded), independent of the daemon process. If you stop and restart `yarradev run`
  while a subagent is still working, it keeps running; the next tick's reconcile picks up its verdict
  from the shared dispatch manifest exactly as if the daemon had stayed up.
- **Control plane.** The daemon listens on `http://127.0.0.1:<runner.port>` (default `4599`),
  **localhost-only** — it binds to `127.0.0.1`, not `0.0.0.0`, so it isn't reachable off the machine.
  There is no additional auth on top of that binding; don't run it on a shared/multi-tenant host without
  additional isolation. `GET /` serves a minimal browser monitor
  (`http://127.0.0.1:<port>/`) that polls `/status` every few seconds.
- **CLI client subcommands** (read `runner.port` from `board.json`, same as the daemon):
  ```
  yarradev status  # paused? pass running? last tick ok? breaker state?
  yarradev pause   # stop claiming new cards (in-flight work finishes)
  yarradev resume  # resume claiming
  yarradev tick    # request an immediate reconcile/dispatch pass
  yarradev logs    # placeholder — not yet wired to a specific verdict file
  yarradev stop    # stop the manifest-watch/timer and close the control plane
  ```
  There's also a `retry` action (`POST /retry`) that requests an immediate tick — it does **not** yet
  perform a full lease-clear on the target card; treat it as "nudge the loop," not "force-unstick this
  card," until that lands.
- **Logs.** The runner never writes inside the plugin/repo checkout. Everything — the dispatch manifest
  and each dispatched subagent's live-streamed verdict/output — lives under the platform data dir:
  `$XDG_DATA_HOME/yarradev` (`~/.local/share/yarradev` by default on macOS/Linux; override with
  `YARRADEV_STATE_DIR`). Verdict output streams to
  `<data dir>/dispatch/<role>-<cardId>-<random>/verdict.txt` as the subagent produces it (so `tail -f`
  works while a subagent is still running); the manifest tracking pending/done dispatches is
  `<data dir>/dispatch-manifest.jsonl`.
- **Auth.** The runner makes **zero model calls itself** — it only talks to the board (via `YDB_TOKEN`/
  `YDB_TOKEN_<ROLE>`) and shells out to `claude -p` for role work, which uses your own Claude Code auth.
  Run it via `kdbx run -- yarradev run` so your board token(s) are injected into that one process without
  ever being exported to your shell or written to disk.

## Run (legacy: in-session `/loop`)

The previous way of driving the same reconcile/dispatch logic — from inside an interactive Claude Code
session, using this skill's conductor persona directly instead of the headless daemon:

```
/model sonnet      # the orchestrator's own LLM work is just routing — keep it cheap
/effort low
/loop 5m /yarradev:yarradev-run
```

This still works (see `skills/yarradev-run/SKILL.md` for the full per-pass procedure it follows — the
same routing `pass.mjs` implements), but it is no longer the supported driver: it ties up an interactive
session for the duration of the loop, and the machine-local `yarradev-loop` bash wrapper that used to
watch for epic completion and restart the session is **retired**. Prefer the headless runner above for
anything long-running or unattended.

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
5. **Run it:** `YDB_TOKEN=orch1.s3cret yarradev run` (or `kdbx run -- yarradev run` if you've vaulted it) —
   watch `http://127.0.0.1:4599/` or `yarradev status` while it ticks. (The legacy in-session path still
   works too: give the orchestrator `orch1.s3cret` in your launch message — it inlines it per call, don't
   `export` it — set `/model sonnet` + `/effort low`, then `/loop 30s /yarradev:yarradev-run`.) Either way,
   watch each gate:
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
exercised only by the demo runbook above — it consumes your subscription and can't be unit-tested.
Automated tests cover the deterministic rail (scripts + gen-fence/gate contract + the runner's daemon,
control plane, and CLI plumbing) only.

## Bugs & feedback

Found a bug? Open an issue:

```
https://github.com/yarradev/yarradev-board/issues/new
```

Include:
- What you were doing (loop pass, card state, edge)
- What happened vs. what you expected
- Relevant output (stdout of the failing act script, conductor log, board response)
- Plugin version (`/plugin list` shows installed plugins and versions)

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

**Also shipped:** the **headless `yarradev run` runner** — a timer + manifest-watch daemon that drives
`pass.mjs` without an interactive Claude Code session, dispatching role subagents as detached `claude -p`
processes (survives runner restart, reconciles on the next tick) and exposing a localhost-only HTTP
control plane (`status`/`pause`/`resume`/`tick`/`stop` + a minimal browser monitor). This is now the
supported driver; the in-session `/loop /yarradev:yarradev-run` procedure is legacy and the old
machine-local `yarradev-loop` bash wrapper is retired. Not yet shipped in the runner: an MCP-based
control surface and an in-plugin operator UI (planned as separate follow-on work).

**Next:** richer cross-stage context persistence (designer's plan → developer), `RENEW` for long jobs,
multi-card concurrency, the analyst/epic tier, and a GitHub App + dashboard for the hosted board.
