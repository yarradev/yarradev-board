---
name: yarradev-run
description: The yarradev board orchestrator — a reconciliation loop that drives every ready card through the lifecycle (spec→dev→test→done→staging→prod, with mechanical CI, a security-advisor, a releaser staging deploy, and a human-GO production gate) by reading a yarradev HTTP board, claiming a lease, dispatching the stage's role subagent via `claude -p`, parsing its verdict, and posting the resulting act. The supported way to run this is the headless `yarradev run` daemon (`kdbx run -- yarradev run`); the in-session `/loop /yarradev:yarradev-run` procedure documented below is retained as a legacy manual/interactive driver of the same logic.
---

# yarradev-run — the orchestrator

**Supported driver: the headless `yarradev run` daemon.** `yarradev run` (start via `kdbx run --
yarradev run`, or `YDB_TOKEN=… yarradev run`) is a long-lived Node process that ticks `pass.mjs` — the
deterministic reconcile/dispatch implementation of everything this skill describes — on a timer plus a
manifest-watch, dispatching role subagents as detached `claude -p` processes. It exposes a
localhost-only HTTP control plane (`http://127.0.0.1:<runner.port>`, default `4599`; `yarradev status |
pause | resume | tick | logs | stop | board | watch`, plus a **browser cockpit** at `http://127.0.0.1:<port>/`).
Detached agents survive a runner restart — they reconcile on the next tick regardless of whether the
daemon that dispatched them is still the one running. Logs (the dispatch manifest + each subagent's
live-streamed verdict output) live under the platform data dir (`$XDG_DATA_HOME/yarradev`, override with
`YARRADEV_STATE_DIR`), never inside this repo. The runner makes **zero model calls** itself — see the
plugin `README.md`'s "Headless runner (supported)" section for the full reference.

**Plugin surface (component ②).** Besides this conductor skill and the CLI daemon above, installing
the plugin also gives you a `yarradev-runner` MCP (11 read/control tools proxying the daemon's
control plane — `status`/`inflight`/`recent`/`logs`/`explain`/`attention`/`pause`/`resume`/`tick`/
`retry`/`board`; no human-gate tools) and a `yarradev-operator` skill you invoke for standup / triage-stuck-
card / attention-sweep / incident / cost runbooks (drafts + a cockpit link for human gates, never
executes them; cost reporting isn't available yet). See the plugin `README.md`'s "Plugin surface
(component ②)" section for the full reference.

**Observability — live status board.** The daemon exposes `yarradev board` and `yarradev watch` CLI commands for observing the board's activity in real time:
- `yarradev board` — print the live status board once (cards in-flight + recently resolved/escalated). Local state only; no board API calls.
- `yarradev watch [--interval <ms>]` — the same board, redrawn live (default 1s). Local state only; no board API calls.
- **Browser cockpit** at `http://127.0.0.1:<port>/` — the live board (state-colored grid) with a status/control bar (breaker, next-tick, pause/resume/tick), a per-card slide-in panel (merged `explain` + `logs`, with retry — and **answer a card's open question** inline, posting `ANSWER` under the human identity), and a "needs a human" attention strip. Polls `/board`+`/status` ~1s (local); the board-attention section calls the board `/attention` on a slow 15s/manual refresh.

The `yarradev-runner` MCP's `board` tool returns the same underlying data as a one-shot JSON snapshot; the live redraw (`watch`) is CLI-only.

**Legacy: the in-session `/loop /yarradev:yarradev-run` procedure below.** This remains available as a
manual/interactive fallback (e.g. for debugging a single pass step-by-step inside a live session) and as
the **parity reference** `pass.mjs` implements, but it is no longer the supported way to run the
orchestrator continuously — prefer the headless daemon above. The machine-local `yarradev-loop` bash
wrapper that used to watch this session's exit and auto-restart it is **retired**.

You are the **conductor** of a yarradev board. You **route; you do not do role work**. Each pass you
reconcile the board (desired state) toward reality by dispatching role subagents, then yield. You hold
**no durable state between passes** — re-read the board every pass.

The deterministic board I/O lives in `scripts/` (plain Node, no judgement). Your only LLM jobs are
(a) **dispatching** role subagents via `node $S/dispatch-and-wait.mjs` (the wrapper around the user-local async `~/work/tools/yarradev-dispatch`), (b) **parsing their verdict**, and
(c) posting the resulting act via the scripts. Separation of powers: **subagents propose · the board
disposes (gates + gen-fences) · you route**.

## Why this runs on your subscription
The orchestrator (this skill) is the **session** model; role workers are dispatched via
`claude -p` in tmux panes through `~/work/tools/yarradev-dispatch` (wrapped synchronously by `$S/dispatch-and-wait.mjs`, see step 2b) — all LLM work draws
from your Claude **subscription**. The board never sees your Claude credential and makes no
model calls. Billing is unchanged — `claude -p` draws from the same Claude subscription.

## Session model + effort
Set these when you start the loop. This skill's only LLM work is routing + verdict parsing, so a cheap
tier is right: **`/model sonnet` + `/effort low`**. Role subagents carry their own `model`/`effort`
(designer & developer opus·high, tester sonnet·low).

## Config & auth
- Scripts: `${CLAUDE_PLUGIN_ROOT}/skills/yarradev-run/scripts/` (call as `node <that>/<name>.mjs`).
- **Headless runner config.** `board.json` also carries a `runner` block read only by `yarradev run`:
  `{ port:4599, passTimeout:120, debounceMs:750 }` — `port` is the localhost-only control-plane port,
  `passTimeout` (seconds) bounds a single `pass.mjs` tick before it's killed, `debounceMs` coalesces
  rapid manifest-file changes (a burst of subagent completions) into one extra tick instead of one per
  change. See `skills/yarradev-run/config/board.example.json`.
- Board config (apiBase, doName, lifecycle, pace, budgets, deploy, runtime): **`.yarradev/board.json` in the
  project root** — committed, per-project (one per board, so multi-project setups each carry their own). A
  partial file merges over the shipped `board.example.json` template (set just `apiBase`/`doName`/`pace` and
  inherit the lifecycle). It holds **no secret**. (A legacy plugin-install `…/config/board.json` overlay is
  still read as a lower-priority layer; apiBase/doName are **not** settable via env — config lives in
  board.json.)
  `budgets` = `{ bounce_limit, per_edge_overrides }` (thrash caps). `transition_budget`/`respawn_window_ms`
  are not board.json fields — the live transition-count backstop and CI-stall respawn window are
  decide()'s client-side `DEFAULT_BUDGETS` (`orchestrator-core/src/config.ts`).
- **Board-served lifecycle (nodes-authored boards) overrides `board.json`'s.** For a board authored via
  the platform's node-DAG flow, `GET /config`'s `machine.lifecycle` (compiled from that DAG) is the
  lifecycle source of truth — `list-ready.mjs`, `pass.mjs`, and `build-prompt.mjs` all route/prompt
  against `machine.lifecycle ?? cfg.lifecycle` (`resolveLifecycle()` in `plugin-io.mjs`), so the served
  lifecycle wins whenever the board provides one. `acme:main` (and any board that serves no lifecycle)
  falls straight through to this `.yarradev/board.json` lifecycle, unchanged.
  `deploy.staging` = the shell command the **releaser** runs to deploy a validated change to staging
  (e.g. `wrangler deploy --env staging`); empty → the releaser escalates asking you to configure it.
  Deploy commands are **validated as untrusted** at config load — a single plain invocation only; no shell chaining, substitution, or redirection (put compound deploys in a committed script). Platform-pushed config never supplies command fields (§14 S3).
- **Lifecycle `gate` tags are plugin-side routing hints — not the enforcer.** A stage's `gate` only tells
  `decide()` how to route (`mechanical` → CI advance/respawn; `human` → promote; `barrier` → promote once
  all children are done; default → dispatch the owner for a judgement verdict). The board's REAL
  enforcement is the compiled `GateExpr` on each transition edge, and the two MUST agree: a
  `gate:"mechanical"` stage that also has an advisor needs its forward edge to declare
  `{all:[{p:"ci_green"},{p:"no_open_veto"},{p:"no_open_hold"}]}`; a `gate:"human"` stage needs
  `{p:"human_go"}`. If the board edge omits the gate, the act commits with **no** enforcement
  (e.g. a promote with no human GO — an authority bypass); if the edge is missing entirely, the MOVE 422s
  with no `blocked_by` and the advance/promote silently never fires.
- **`gate:"barrier"` is an epic fan-in — routed as a promote, NOT a CLAIMing advance.** An epic's
  `integrating` stage stays parked until every child story is terminal, then `decide()` emits
  `{kind:"promote", to, role}` (role = the stage's `promoteAs`, e.g. `analyst`). It is promote-shaped
  because the barrier stage has `owner:""` — a CLAIMing advance would CLAIM with an empty role and
  `claim.mjs` would exit 2, stalling a completed epic every pass. The board's `all_children_terminal`
  gate on the `integrating→done` edge is the real enforcer (a promote posted while a child is still
  non-terminal 422s with `blocked_by ⊇ all_children_terminal`). Both promote flavors — human gate and
  barrier — go through the single `promote` branch below; they differ only in the `role` the line carries.
- **Board bearer token(s) — pass INLINE, never export, never to a subagent.** A token (shaped
  `<token_id>.<secret>`) authenticates you to the board; it is **not** a Claude credential. Pass it inline
  on **every** script call so it lives only in that one process. Do **NOT** `export` it, write it to a
  file, or place it in a subagent's prompt: role subagents have Bash and share this machine, so a
  persisted token is readable by them (`printenv`/`cat`) and would let a prompt-injected subagent forge
  acts under that identity.
- **Per-role identities (least privilege).** Each act is posted under the **role that produced it**, via a
  per-role token: the scripts read `YDB_TOKEN_<ROLE>` (upper-case, `-`→`_`: `YDB_TOKEN_DEVELOPER`,
  `YDB_TOKEN_SECURITY_ADVISOR`, `YDB_TOKEN_CODE_REVIEWER`, `YDB_TOKEN_ORCHESTRATOR`, `YDB_TOKEN_DESIGNER`,
  `YDB_TOKEN_TESTER`, `YDB_TOKEN_RELEASER`, `YDB_TOKEN_ANALYST`, `YDB_TOKEN_DEVOPS`, `YDB_TOKEN_HUMAN`), **falling back to the
  shared `YDB_TOKEN`** if a role's token isn't set (the fallback is logged to stderr). You hold **all** the
  role tokens and the scripts select the right one per act; **subagents still never see any token**.
  Mapping: `claim`/`clear-lease`/`escalate` → orchestrator · `move`/`reject` → the **stage owner** (passed
  as the last arg) · `link-pr`/`push` → developer · `veto`/`hold` → security-advisor (the only advisor with
  veto/hold authority) · `advice` → **the dispatched advisor's role for this stage** (passed via `--role`,
  e.g. security-advisor or code-reviewer — NOT hardcoded, since any configured advisor may post a
  clean/advice review) · `promote` → releaser (or the barrier's `promoteAs` role, e.g. analyst) ·
  `create` (epic decomposition) → analyst · `create`/`note` (Task A7 bug-spawn — `advice.spawn[]` →
  `bug-<fingerprint>` card + repro note) → **orchestrator** (role-agnostic primitive; not attributed to the
  reviewing advisor) · `reconcile-spawn.mjs` (Phase B / B4 — draining an out-of-band
  `derived_json.pending_spawn`, same CREATE/NOTE pair as the in-lifecycle bug-spawn) → **orchestrator**,
  same rationale (role-agnostic; the review-bridge's own `write:advice` token, separate from every
  `YDB_TOKEN_<ROLE>` here, only ever posts the ADVICE act itself — see `enable-review-bridge`) ·
  `human-go`/`clear-veto` → human.
  Inline the whole set at loop start, e.g. `YDB_TOKEN_ORCHESTRATOR=… YDB_TOKEN_DEVELOPER=… … node $S/…`
  (or just `YDB_TOKEN=…` for a single-identity setup — everything falls back to it).
- **Epic-boundary signal (legacy in-session use only).** When an epic reaches `epic_done`,
  `pass.mjs` still writes `/tmp/yarradev-epic-done` (JSON: epic id, title, completedAt, storyCount) —
  the in-session conductor calls `/exit` after posting it. The machine-local wrapper that used to watch
  this file and restart the session (`~/work/tools/yarradev-loop`) is **retired**, so under the
  legacy in-session `/loop` procedure the conductor now just exits cleanly and you restart manually.
  Under the **headless runner**, this signal is inert (nothing consumes it) and harmless — the runner
  has no accumulated session context to clear in the first place, since each `pass.mjs` tick is a fresh,
  short-lived subprocess. There is **no context-pressure valve** (no `/tmp/yarradev-prep-clear`, no
  pass counter) — that mechanism existed only for the old long-running interactive session and has been
  removed; `pass.mjs` is a pure reconcile → dispatch → exit per tick, nothing more.

## Per-pass procedure (one /loop invocation — legacy in-session driver; `pass.mjs` is the parity reference)
Let `S=${CLAUDE_PLUGIN_ROOT}/skills/yarradev-run/scripts`.

> **PRIMARY — run `node $S/pass.mjs` each pass.** `pass.mjs` is the default conductor, and is what the
> **headless `yarradev run` daemon ticks on your behalf** (you never invoke it by hand there). It
> **reconciles** landed verdicts (re-CLAIM at verdict time for **worker** verdicts, so a long subagent's
> verdict isn't stranded by lease-TTL gen-bumps — fixes #27's recovery gap; **gen-exempt advisor verdicts
> (`advice`/`clean`/`veto`/`hold`) post directly with no re-CLAIM — #81**, since a re-CLAIM would 409 on the
> active lease and drop the verdict, the clean-card livelock. It **does** CLEAR_LEASE when the advisor
> actually held one — an advisor is only leaseless on the 422-reshape path; `decide()` also dispatches an
> advisor as `kind:"work"` when `advisor_clear` fails, and `dispatchNew` CLAIMs that role-blind, so the
> ledger carries a gen. Leaving it dangling stalls the card for the full `claimTtlS` (`decide()` noops on
> `leased`) — **#85**. A failed advisor act is surfaced (`act_failed`) and, when transient, leaves the
> verdict **unconsumed** so the next pass re-posts it rather than losing the advisor's work), **fans out** up to `effectiveK` concurrent dispatches —
> `min(pace.maxCardsPerPass, pace.maxConcurrent − in-flight)`, dropped to 0/1 by the 529 circuit breaker
> (#28), routes every verdict with full parity, and writes the `epic_done` signal. It is a **pure
> reconcile → dispatch → exit per invocation** — there is no context-pressure check and no pass counter;
> those existed only in the old long-running in-session conductor and have been removed (see
> "Epic-boundary signal" above). **Fallback:** if `pass.mjs` is unavailable or hits an unexpected error
> in the **legacy in-session `/loop`** procedure, the step-by-step loop below (steps 1–3) remains the
> manual fallback. The detailed steps below are
> otherwise the **parity reference** `pass.mjs` implements — audit them, don't execute them when
> `pass.mjs` runs. Spec: `docs/superpowers/specs/2026-07-07-pass-mjs-async-reconcile-design.md`.
> **Known V1 gap:** autonomous `release.mjs` on `done→staging` is not yet ported — staging→prod stays
> human-gated (the safe default).

### Native dispatch mode (interactive Claude Code — `runtime.dispatchMode: "native"`)

When `runtime.dispatchMode` is `"native"` and you (the conductor) are running in a continuous
interactive Claude Code session, `pass.mjs` does **not** spawn `claude -p`. Instead it emits one
`{"action":"dispatch-request", ...}` JSON line on stdout per card it selected (already bounded by
`pace.maxCardsPerPass`/`maxConcurrent` and the 529 breaker — do not re-bound). For each such line:

1. Read `promptPath` (the **combined** role+card prompt) — its contents are the subagent prompt.
2. Spawn the role subagent via the **`Agent` tool, `run_in_background`**, so it shows in the status line.
   Use the request's `subagentType` field as the `Agent` tool's `subagent_type` (`dispatch.mjs` resolves it
   from `board.json`'s `roles` block, else the write/read default). Pass `model` from the request. If the
   request's `worktreeFlag` is non-empty (write-roles only —
   the same set that gets `--worktree` in external mode), also pass `isolation: "worktree"` to the
   `Agent` tool so this subagent runs in its own git worktree — required so parallel edits under
   `K` > 1 fan-out don't corrupt a shared tree. ⚠️ A project's `board.json` `roles` block (GH #53)
   can set `worktree: false` per role — doing so on a write-capable role (developer/releaser/
   tester/devops) under `maxConcurrent > 1` disables this isolation, so parallel write-role
   subagents edit the SAME working tree and corrupt it.
3. When the agent completes (its `task-notification`), take its **final message** (the verdict block) and
   land it: `printf '%s' "<agent final message>" | node $S/dispatch.mjs --complete <verdictPath> <cardId> --gen <gen> --role <role>`.
   This writes the verdict file + `done` manifest entry — exactly what the next reconcile pass consumes.
   **If the subagent failed or was overloaded** (it returned no fenced verdict block — e.g. a gateway
   529/overload, or a crash), do NOT pipe empty/prose text: pipe a bare error-envelope JSON line instead,
   so reconcile's `parseErrorEnvelope` (GH #44) still trips the 529 breaker exactly as external mode does.
   Shape: `{"status":"error","error_type":"gateway_529"|"crash","detail":"<short reason>"}` — use
   `"gateway_529"` when the agent's output/failure mentions 529/overload, otherwise `"crash"`. Example:
   `printf '%s' '{"status":"error","error_type":"gateway_529","detail":"agent overloaded, no verdict"}' | node $S/dispatch.mjs --complete <verdictPath> <cardId> --gen <gen> --role <role>`.
4. Do nothing else — the **next** `pass.mjs` run reconciles the landed verdict and posts the act (routing,
   breaker, epic signals all unchanged). This is next-tick reconcile; latency ≤ one loop interval.

If you are **not** in an interactive session with an `Agent` tool (headless/cron), set
`dispatchMode: "external"` (the default) — `pass.mjs` spawns `claude -p` and this protocol does not apply.

1. **List ready cards:** `node $S/list-ready.mjs` → one JSON line per actionable card:
   `{ "kind":"work"|"advance"|"respawn"|"reclaim"|"promote"|"escalate", "id", "state", "role"?, "to"?, "reason"?, "title" }`.
   `work` carries role+to; `advance` carries role+to; `respawn` carries role; `reclaim` carries role+to
   (a prior lease expired — take it over and re-dispatch the owner, exactly like `work`); `promote` carries
   to (a promote-shaped gate — human `staging→prod`, or an epic fan-in `barrier` which ALSO carries `role`);
   `escalate` carries reason (a budget is exhausted / CI stalled — park for a human).
   Waiting cards (terminal/blocked/leased/ci-pending/ci-absent/…) are logged to stderr and skipped.
1b. **Reconcile out-of-band bug-raise requests (Phase B / B4, auto-raised-bug-cards §6).** Independent
    of step 1's `decide()` routing — a card can carry a `pending_spawn` regardless of its lifecycle
    action, since raising a bug never MOVEs the reviewed card. This drains findings an out-of-lifecycle
    `/code-review` posted via the review-bridge (`raise-bugs-from-review.mjs`, B3.5): the bridge holds a
    `write:advice`-only delegate (B1) and can post nothing but a single ADVICE act, which the board's
    fold (B3) accumulates onto `derived_json.pending_spawn` — this step is the ONLY thing that ever
    turns those requests into bug cards (only the orchestrator creates cards).
    1. `node $S/reconcile-spawn.mjs` scans every card via the SAME `getEnriched()` reads step 1 already
       performs (`pending_spawn: PendingBugSpawn[]` on the enriched projection); for each card whose
       `pending_spawn` is non-empty, it drains it in-process (no extra subagent dispatch — this is
       mechanical, not judgement) by mirroring the A7 spawn branch's exact steps per entry, in order:
       compute the deterministic id (`fingerprint.mjs`, using the entry's own `repo` — REQUIRED on every
       out-of-band entry, unlike the in-lifecycle `advice.spawn[]` shape, since there is no "this pass's
       advisor dispatch context" to source it from here), pre-check via `getEnriched(id)` (dedup — a
       fully-filed entry, i.e. it exists AND its `notes[]` is non-empty, is a cheap skip), then
       `create.mjs --id <id> --type bug --state dev --parent <cardId> --role orchestrator` if absent,
       then `note.mjs <id> "<entry.note>"` if a repro note is present and not yet posted (a card that
       exists with empty `notes[]` retries the NOTE alone, never re-CREATEs).
    2. **Cap = 20 mutations (CREATE/NOTE calls) per card per pass**, mirroring `reduce()`'s spawn cap —
       but it bounds NEW work, not entries examined: an already-filed entry is a free read-only skip and
       does NOT count against it, so an old, fully-processed prefix of `pending_spawn` never starves
       newer entries appended after it. Entries beyond the cap are **deferred to the next pass, not
       dropped** (`pending_spawn` is never trimmed — v1 relies on the existence pre-check alone, per the
       design's "no extra bookkeeping" decision).
    3. **A CREATE or NOTE failure stops this card's reconcile for this pass** (log it; don't escalate) —
       exactly like the in-lifecycle branch's stop-on-error rule. The next pass re-observes the SAME
       `pending_spawn` (still there, untrimmed) and retries from scratch; the pre-check makes re-creating
       already-committed bugs a no-op.
    4. This step touches **no lease, no gen, no CLAIM** — `pending_spawn` isn't part of any card's
       fencing, so it can run before, after, or interleaved with step 2's per-kind dispatch without any
       ordering dependency on it.
2. **For each actionable card, sequentially, up to `effectiveK` (≤ `pace.maxCardsPerPass`, default 3), branch on `kind`:**

   **`escalate`** — a budget is exhausted / CI is stalled; park for a human (**no CLAIM, no dispatch, no quota**):
   1. `node $S/escalate.mjs <id> "<reason>"` — opens a question via `ASK` → the board sets `blocked=true`.
   2. Log. The card is now parked; `list-ready` skips it until a human posts an `ANSWER` to resume.

   **`advance`** — a mechanical gate (e.g. CI) is satisfied; MOVE with **no dispatch** (no subscription cost):
   1. `node $S/claim.mjs <id> <role> <pace.claimTtlS>` → keep `gen` (`ok:false` → log `claim-failed`, skip).
      (`role` is the mechanical stage's owner, carried on the `advance` line — don't hardcode `developer`.)
   2. `node $S/move.mjs <id> <gen> <to> <role>` (posts under the stage owner's identity). Prints
      `{ ok, status, outcome, blocked_by? }` (all act scripts now surface `blocked_by` from the board's
      AppendResult). Committed → advanced. **422 `gate_blocked`** (CI flipped since the list) → log,
      fall through to CLEAR; next pass re-derives.
   3. `node $S/clear-lease.mjs <id> <gen>` — always.

   **`promote`** — a promote-shaped gate: MOVE at the card's CURRENT gen (**no CLAIM** — a CLAIM bump would
   invalidate the gen-stamped GO / the barrier's child-completion facts), **no dispatch**. Two flavors,
   discriminated by the line's `role` (from `list-ready`, which forwards `a.role` when `decide` set it):
   the **human gate** (`staging→prod`) carries **no role** → releaser default; the **epic fan-in barrier**
   (`integrating→done`) carries `role` = the stage's `promoteAs` (e.g. `analyst`). Don't hardcode the
   role or the state names — pass through what the line gives you:
   0. **Autonomous release (human gate ONLY — the no-`role` `staging→prod` flavor).** If the board's
      compiled machine (from `GET /config`, already read for the coherence gate) contains a
      `type:"RELEASE"` transition **and** the loop token carries the `board:release` grant (autonomous
      release is enabled for this board), attempt `node $S/release.mjs <id>` **FIRST** (posts a RELEASE at
      the card's current gen — read the target state from the RELEASE edge's `to`, do NOT hardcode `prod`):
      - **`committed`** → the card is now in the RELEASE target (prod). Do the prod rollout:
        run `cfg.deploy?.prod` then `cfg.smoke?.prod`, then fold the smoke via
        `node $S/smoke.mjs <id> <releaseTo> <state>`. **Empty `deploy.prod`/`smoke.prod` → escalate to a
        human (`node $S/escalate.mjs`); NEVER silently pass.** On **prod-smoke red** apply
        `cfg.release?.on_smoke_fail` (default `halt`): `halt` → `escalate.mjs` + **stop** the loop for this
        card; `park` → escalate + leave it; `rollback` → run `cfg.rollback?.prod` then `escalate.mjs`.
        Then skip the human-gate steps below (the promote is done).
      - **403 (`outcome:"unauthorized"` — the token lacks `board:release`)** or **422
        (`blocked_by ⊇ auto_release` — the floor isn't green)** → **FALL BACK** to the existing human-GO
        wait below (log "awaiting human GO", unchanged). This is the fail-closed default: a denied or
        blocked autonomous release NEVER promotes; production stays human-gated.
      - When the machine has **NO `type:"RELEASE"` edge** (autonomy off) → **skip `release.mjs` entirely**;
        behavior is exactly today's human-GO gate (steps 1–2 below).
   1. `node $S/promote.mjs <id> <to> [role]` — forward the line's `role` when present (omit it → promote.mjs
      defaults to `releaser`). MOVEs at the card's current gen.
   2. `committed` → promoted to `<to>`. On **422**, branch on `blocked_by` (do NOT hardcode state names —
      read the failing predicate):
      - **`blocked_by ⊇ human_go`** (human gate) → log "awaiting human GO" and wait. A human (a
        `byKind:human` identity) runs `node $S/human-go.mjs <id>` to approve; the next pass's promote then
        commits. **Agents cannot self-approve a release.**
        ⚠️ The card must already read state `staging` before the human posts `HUMAN_GO`: the GO is
        gen-stamped, and the prior `done→staging` deploy CLAIM bumps the gen — a GO posted while the card is
        still in `done` is invalidated by that bump.
      - **`blocked_by ⊇ all_children_terminal`** (epic barrier) → a child regressed out of terminal AFTER
        `decide` derived the promote (the list is a snapshot). This is NOT a human-GO wait: just **log it
        and fall through** — the next pass re-derives (it re-reads child completion and either re-parks the
        barrier `noop fan-in n/total` or re-promotes once the child is terminal again). No human action.
      - any other `blocked_by` → log and let the next pass re-derive (same as `advance`'s 422 path).
   **Epic completion.** If this promote was for an epic card (`type === "epic"`) and the
   transition was `epic_integrating → epic_done` (the barrier gate cleared), the epic and all
   its children are terminal. After CLEAR_LEASE:
   1. Gather summary: epic id, title, `children_total`, current time.
   2. Write `/tmp/yarradev-epic-done`:
      `{"epicId":"<id>","title":"<title>","completedAt":"<ISO8601>","storyCount":<children_total>,"bugCount":0}`
   3. Call `/exit`. The wrapper restarts the session with clean context.
   
   If this was NOT an epic barrier (e.g. human GO `staging→prod`), do NOT write the signal —
   the loop continues normally.

   **`work`**, **`respawn`**, or **`reclaim`** — dispatch the stage owner (`reclaim` = a prior lease
   expired; handle it identically to `work`):
   1. **CLAIM:** `node $S/claim.mjs <id> <role> <pace.claimTtlS>` (on `kind:"respawn"`, append **`--respawn`**
      — the board's CLAIM fold then counts it toward the transition budget, v1 parity: without it a stuck
      CI-fail respawn loop never approaches `transition_budget`, bounded only by the 60s `respawn_window_ms`
      leg) → keep **`gen`** (`ok:false` → skip). Thread `gen` **verbatim** into the act you post and into
      CLEAR_LEASE; never reuse a gen across passes.
   2. **DISPATCH one subagent** in a **tmux pane** via the dispatch wrapper:
      a. **Build the subagent prompt** with `P=$(node $S/build-prompt.mjs <role> <cardId> [--to <to>] [--extras-file <path>])`.
         It fetches the card and writes `/tmp/yarradev-prompt-<cardId>.txt` (override with `--out`) containing
         the dispatch context (`{doName, cardId, state, to, role, title}`) AND the card's existing `notes[]`
         (prior-stage rationale — designer plan, reviewer findings) so the next owner reads forward context
         instead of re-deriving it (GH #18); routing the file through the helper (not a hand-rolled heredoc)
         also kills the shell-escaping footgun on titles/notes. `--to` defaults to `lifecycle[state].to` —
         pass it explicitly for non-default edges (e.g. a REJECT's backward `to`). For role-specific extras
         (deploy commands, mode, advisor context), write them to a file and pass `--extras-file`. **The prompt
         file must never contain board tokens** (the helper uses the token only for the fetch and writes none).
      b. **Run the dispatch:** `V=$(node $S/dispatch-and-wait.mjs <role> <cardId> "$P")`
         - `dispatch-and-wait.mjs` wraps the user-local **async** `~/work/tools/yarradev-dispatch` tool and
           **blocks until the subagent's verdict is ready**: it dispatches (backgrounding `claude -p`), then
           polls the dispatch manifest (`~/.local/share/claude-bg/dispatch-manifest.jsonl`) for the matching
           `{"status":"done","verdictPath":…}` entry, then prints the verdict file path.
         - The wrapped tool reads the role's model/effort/tools from `$CLAUDE_PLUGIN_ROOT/agents/<role>.md`;
           `developer` and `releaser` get `--worktree` isolation automatically.
         - Do NOT call `~/work/tools/yarradev-dispatch` directly — it is fire-and-forget (returns the verdict
           path immediately while `claude -p` is still running), so a bare `cat $V` reads an empty file and
           the conductor mis-reads "no JSON block" as a dispatch failure (GH #19). The wrapper is what makes
           `cat $V` below read the *completed* verdict.
      c. **Read the verdict:** `cat $V`, then parse the last fenced ` ```json ` block.
         All routing below (advisor verdict, judgement advance/reject, mechanical submitted,
         analyst decomposed, question) is unchanged.
   3. **PARSE** the last fenced ` ```json ` block and post the matching act with `<gen>`:
      - **Advisor verdict — applies whenever the dispatched `role` is the stage's advisor** (e.g.
        `security-advisor`, `code-reviewer`, or any other configured advisor role), on BOTH
        advisor-dispatch paths: (i) `decide` dispatched the advisor as the primary `work`/`reclaim`
        item (this pass's `role` is the advisor), (ii) the inline post-submit review below, and (iii) the
        judgement-stage advisor dispatch further below (a judgement stage, e.g. `test`, whose owner's
        `advance` is gate-blocked on `advisor_clear`). The advisor returns `{status, head, reason?}` for
        `advice`/`clean`/`veto`/`hold` (`reason` accompanies veto/hold/advice; `clean` omits it), OR
        `{status:"reject", reason}` — **no `head`** — for an advisor holding a `REJECT` cap (e.g.
        `code-reviewer`'s blocking verdict: a confirmed bug that IS the reviewed card's own WIP, not a
        separate/pre-existing one). Post — **never "log only"** — keyed on `status`:
        - `advice`/`clean` → `node $S/advice.mjs <id> <head> "<reason>" --role <role>` — records a CLEAN
          review at `<head>`, posted under **this pass's dispatched advisor role** (`<role>`, e.g.
          `security-advisor` or `code-reviewer`) so the ADVICE is attributed to the advisor that actually
          reviewed it, not silently misattributed to security-advisor's identity when a different advisor
          is configured for this stage. `advice.mjs` defaults `--role` to `security-advisor` when the flag
          is omitted (preserves single-advisor behavior), but you **must** pass `--role <role>` explicitly
          here, matching `create.mjs`'s `--role` convention. Recording this so `advisor_clear` goes
          non-vacuous and the card advances next pass. **Skipping this is the clean-card livelock**: no
          `advisor_state` row → `advisor_clear` false forever → `decide` re-dispatches the advisor every
          tick.
          - **Sub-clause of the above — `advice` ALSO carrying `spawn[]`** (Task A7/A8 — reviewer-raised
            bugs, e.g. `code-reviewer`'s verdict `{status:"advice", head, reason?, spawn:[{title, file,
            summary, note?}]}`). **⚠️ Spawn entries are RAW — `{title, file, summary, note?}` — NOT
            `{title, fingerprint, note?}`: an LLM reviewer cannot reliably compute a sha256 fingerprint
            itself, so the conductor computes it, never the reviewer.** This refines the `advice`/`clean`
            route immediately above — it is **not** a separate top-level route (don't double-post
            `advice.mjs`): first post `advice.mjs` exactly as above (once), **then** for EACH `spawn[i]` in
            order (cap at 20 entries per verdict, mirroring `reduce()`'s cap — if `spawn.length` exceeds it,
            process only the first 20 and log the drop count; do not escalate):
            1. **Compute the deterministic id.** `id=$(node $S/fingerprint.mjs "<repo>" "<spawn[i].file>"
               "<spawn[i].summary>")` → prints `bug-<fp>` (the full card id, already prefixed). `<repo>` is
               **not re-fetched** — it's the same `repo` value already resolved for this pass's advisor
               dispatch context (the `{ doName, cardId, repo, branch, head, watch_paths? }` passed into the
               subagent this pass, sourced — per the identity-mapping table above — from the card's linked
               PR). Use `<id>` (the full `bug-<fp>` string this script printed) for BOTH steps 2 and 3 below
               — never recompute or hand-roll the hash inline.
            2. **Pre-check (dedup — idempotent on both CREATE and NOTE).** Read `<id>` the SAME way
               `list-ready.mjs`/`decide()` read any card — `client.getEnriched(id)`, i.e.
               `GET /boards/<doName>/cards/<id>/enriched`. Fetch the
               **body**, not just the status — you need `notes[]` (the A4 materialized NOTE thread,
               `getEnriched`'s `notes: CardNote[]`) to tell whether the repro note already landed, not
               merely whether the card exists. Concretely:
               ```
               curl -s -w '\n%{http_code}' \
                 -H "authorization: Bearer $YDB_TOKEN_ORCHESTRATOR" \
                 "$YDB_API_BASE/boards/$YDB_DO_NAME/cards/<id>/enriched"
               ```
               Branch:
               - **non-2xx** → absent — continue to step 3 (CREATE, then NOTE if `spawn[i].note` is set).
               - **2xx** → the card already exists — check `spawn[i].note`:
                 - empty/absent → nothing to attach — **SKIP** this entry, move to `spawn[i+1]`.
                 - non-empty and the body's `notes` array is **empty** → the card was created on a prior
                   pass but the NOTE call failed or was interrupted before it landed — **skip straight to
                   step 4** below (do NOT re-run CREATE — the card exists) to (re)post the repro note.
                 - non-empty and `notes` is **non-empty** → already fully filed — **SKIP** this entry, move
                   to `spawn[i+1]`.
               ⚠️ **Known limitation:** this dedups on note-thread emptiness, not on note *content* — if
               something else ever wrote a NOTE to a freshly-minted `<id>` card before its repro NOTE
               landed, the repro note would be wrongly treated as already posted and skipped. Acceptable
               today because nothing else writes to a `<id>` card between its CREATE and its repro NOTE
               in normal operation — only this branch ever touches it.
            3. `node $S/create.mjs "<spawn[i].title>" --id <id> --type bug --state dev --parent <cardId>
               --role orchestrator` — mints the bug card under the **ORCHESTRATOR** identity (parented to
               the reviewed card; the board bumps its `children_total`, same as the analyst `decomposed`
               branch below). `create.mjs` defaults `--role` to `analyst` when the flag is omitted — you
               **must** pass `--role orchestrator` explicitly here, matching the mapping table above
               (`create`/`note` (Task A7 bug-spawn) → orchestrator) and `note.mjs`, which already hardcodes
               it; omitting it would post the CREATE under `YDB_TOKEN_ANALYST` instead, violating the
               load-bearing invariant that only the orchestrator creates cards. A CREATE failure is **not**
               silently swallowed — log it and stop issuing further spawn entries for this card this pass;
               the next pass re-dispatches the reviewer (the reviewed card hasn't moved — raising a bug
               never MOVEs the source card) and it can re-emit the same `spawn[]`; the dedup pre-check
               (step 2, keyed on the SAME deterministic `<id>` recomputed from the same `(repo,file,summary)`)
               makes re-creating already-committed bugs a no-op.
            4. If `spawn[i].note` is non-empty, `node $S/note.mjs <id> "<spawn[i].note>"` — attaches the
               repro body (file:line, failure_scenario, category, source) to the new bug card. Skip this
               call entirely when `note` is empty/absent — don't post a blank NOTE. A NOTE failure here is
               **also not silently swallowed** — log it and stop issuing further spawn entries for this
               card this pass, exactly like a CREATE failure in step 3 above: the next pass's pre-check
               (step 2) sees the card exists with an empty `notes[]` and retries the NOTE alone, without
               re-running CREATE (this is what makes the CREATE→NOTE pair idempotent as a whole, not just
               the CREATE half).
        - `veto` → `node $S/veto.mjs <id> <head> "<reason>"`; `hold` → `node $S/hold.mjs <id> <head> "<reason>"`
          — parks the card (`decide` noops `veto-open`/`hold-open`; the board's `no_open_veto`/`no_open_hold`
          gate blocks dev→test) until an accountable human runs `clear-veto.mjs` (a `clear_authority`
          signatory) — *you flag; a human signs off*.
        - `reject` → route via the **REJECT routing** rule below (the advisor persona never emits `to` —
          the conductor derives the backward edge). This is `code-reviewer`'s blocking verdict; the
          `security-advisor` never emits it (no `REJECT` cap — VETO/HOLD are its only binding verdicts).
      - judgement `status:"advance"` → `node $S/move.mjs <id> <gen> <to> <role>` (posts under the stage owner),
        THEN, if the verdict carries `summary`/`evidence`, `node $S/note.mjs <id> "[<role>→<to>] <summary>
        <evidence>"` — `note.mjs` is gen-exempt (posts under the orchestrator identity, ignores gen), so it
        will not race the MOVE's gen fence. Skip the NOTE when both fields are empty. This persists the
        stage's rationale (e.g. the designer's plan) onto the card's `notes[]`, which the next owner reads
        forward via the `notes[]` injected into its dispatch prompt (step 2a) instead of re-deriving it
        from scratch (GH #18).
        - **422 `gate_blocked` with `blocked_by ⊇ advisor_clear`** — this stage has a configured advisor
          (e.g. `code-reviewer` at `test`) that hasn't reviewed the linked head yet. Unlike the mechanical
          `dev` stage (whose CI-driven branch dispatches the advisor automatically — leg 12 above, or the
          post-submit review further below), a judgement stage dispatches its OWNER every pass with no
          earlier point to have invited the advisor — so do it HERE, inline, same pass, before giving up:
          1. Derive `<advisorRole> = cfg.lifecycle[state].advisors?.[0]?.role` (board.json's lifecycle for
             THIS state — never hardcode a name) and dispatch via the same pattern as step 2:
             write the advisor prompt to `/tmp/yarradev-prompt-<cardId>.txt` with
             `{ doName, cardId, repo, branch, head, watch_paths }`, then
             `V=$(node $S/dispatch-and-wait.mjs <advisorRole> <cardId> /tmp/yarradev-prompt-<cardId>.txt)`
             and `cat $V` for the verdict (the wrapper blocks until the advisor's verdict lands, so this
             inline same-pass advice actually completes) — the SAME context/sourcing as the
             mechanical **Advisor review** step below (repo/head from the card's linked PR, watch_paths
             from the stage's advisor config).
          2. Route its verdict via the **Advisor verdict** rule above:
             - `advice`/`clean` → post `advice.mjs` (clears `advisor_clear`), THEN **retry**
               `node $S/move.mjs <id> <gen> <to> <role>` at the SAME `<gen>` — `ADVICE` is `gen-exempt`
               (never bumps `current_gen`), so the CLAIM's gen from step 1 of this pass is still valid.
               Committed → advanced. A further 422 here is unexpected — log it, CLEAR_LEASE, and let the
               next pass re-derive; do **not** loop a second inline advisor dispatch within this pass.
             - `reject` → route via the **REJECT routing** rule below INSTEAD of retrying the MOVE — the
               advisor bounced the card for rework; the owner's `advance` verdict is superseded, don't
               also post it.
             - `veto`/`hold` → `veto.mjs`/`hold.mjs` as usual — parks the card; the owner's `advance` is
               moot this pass (the park IS the outcome).
          A stage with **no configured advisor** never produces `blocked_by ⊇ advisor_clear`, so this
          bullet is inert for it. Any OTHER `blocked_by` → ordinary Failure-map handling (CLEAR_LEASE;
          the next pass re-derives).
          - **Head/branch sourcing for this async reshape (GH #55):** `pass.mjs`'s actual prompt builder for
            this path (`makeBuildAdvisorPrompt`) does NOT get `repo`/`branch` from the owner's dispatch
            context — that context is reconstructed at reconcile time and is often empty for tester-owned
            stages. It sources `head` from the card's linked PR (`linked_head_sha`, falling back to
            `ctx.head` if the card fetch fails) and has the advisor **self-discover its own branch by
            `cardId`** (e.g. `git branch -r --list 'origin/*<cardId>*'`) rather than being handed one.
      - judgement `status:"reject"` → **REJECT routing.** The stage owner's OWN reject verdict always
        carries `verdict.to` (e.g. the tester's `{status:"reject","to":"dev"}`) — post
        `node $S/reject.mjs <id> <gen> <verdict.to> <role>` (backward REJECT edge, posted under the stage
        owner). An ADVISOR's reject verdict (e.g. `code-reviewer`'s `{status:"reject", reason}`)
        deliberately carries **NO** `to` — an advisor persona must never hardcode a stage name — so the
        CONDUCTOR derives it instead: scan the board's compiled machine (`GET /config`, already read this
        pass for the coherence gate / RELEASE detection) for transitions with `from === state && type ===
        "REJECT"`; there must be **exactly one** match (the lifecycle's single backward edge for this
        stage) — zero or more than one → `escalate.mjs` (never guess). Then post `node $S/reject.mjs <id>
        <gen> <derivedTo> <advisorRole>` — `<gen>` is `current_gen`, already held from this pass's CLAIM
        (an advisor holds no lease of its own; `REJECT` only needs `gen === current_gen`, not an active
        lease), and `<advisorRole>` (NOT the stage owner) so the bounce is attributed to the advisor that
        raised it.
        Either way, if `reject.mjs` returns **422 `bounce budget exhausted`** the edge has thrashed too
        often → run `node $S/escalate.mjs <id> "bounce budget: <edge>"` (park for a human) instead of
        re-looping.
      - **analyst `status:"decomposed"`** (`epic_decompose`, `evidence`-free — the fields are top-level:
        `to`, `children:[{title, depends_on?}]`, `summary`) — a **zero-length `children` array is not a valid
        decomposition**: treat it exactly like `status:"question"` below (escalate/park), mirroring
        `reduce()`'s escalate-on-0-children. Otherwise, derive `<epicId>`/`<gen>`/`<to>` from this pass's
        state (never hardcode a stage name) and:
        1. For each `children[i]`, in order: `node $S/create.mjs "<children[i].title>" --parent <epicId>`
           (mints a child story card under the epic; the board bumps the epic's `children_total` per
           CREATE), appending `--depends-on "<children[i].depends_on joined with ','>"` when the child
           carries `depends_on` (GH #32 — the card won't be actionable until each dep reaches `done`).
           A CREATE failure mid-loop is **not** silently swallowed — log it and stop issuing
           further CREATEs for this card this pass; the next pass re-dispatches the analyst (still at
           `epic_decompose`, since the epic hasn't moved) and it can re-decompose from scratch.
        2. Then `node $S/move.mjs <epicId> <gen> <to> analyst` — advances the epic to `<to>` (the barrier
           stage) now that its children exist. **If this MOVE fails**, the children are already minted but
           the epic can't reach the barrier — an inconsistent half-advance. Do not silently retry: surface it
           (reconcile outcome `act_failed`) AND `node $S/escalate.mjs <epicId> "decomposed: children created
           but barrier advance failed"` (loud board signal for a human), same as a mid-loop CREATE failure.
        3. CLEAR_LEASE as usual (every branch clears the lease — see step 4 below).
      - mechanical `status:"submitted"` `evidence:{repo, pr_number, head}` — choose the act by **`kind`**,
        never by a second snapshot read:
        - `kind:"work"` (first submission) → `node $S/link-pr.mjs <id> <gen> <repo> <pr_number> <head>`.
        - `kind:"respawn"` (fix) → `node $S/push.mjs <id> <gen> <repo> <pr_number> <head>`.
        - **Do NOT MOVE** — the card waits for CI; a later `advance` pass moves it. (A PUSH with no prior
          LINK_PR strands CI, so the work→LINK_PR / respawn→PUSH split is load-bearing.)
        - **Recover stranded CI** (right after the LINK_PR/PUSH): `node $S/reattach-ci.mjs <id> <repo>
          <pr_number> <head>`. CI webhooks frequently complete BEFORE the pr_link row exists, so the board
          drops them and `ci_rollup` stalls at `absent` → card hangs at `dev` (GH #21). This re-triggers
          the head's CI run when GitHub shows completed checks the board never recorded, so a fresh
          completion webhook lands against the now-existing pr_link. Best-effort — no-ops if CI already
          landed or is still pending, and exits 0 on any gh failure (never blocks the pass).
        - **Advisor review** (stages with a configured advisor): after the LINK_PR/PUSH, dispatch the
          STAGE's configured advisor via the same dispatch pattern as step 2:
          write the advisor prompt to `/tmp/yarradev-prompt-<cardId>.txt` with
          `{ doName, cardId, repo, branch, head, watch_paths }`, then
          `V=$(node $S/dispatch-and-wait.mjs <advisorRole> <cardId> /tmp/yarradev-prompt-<cardId>.txt)`
          and `cat $V` for the verdict (the wrapper blocks until it lands), where `<advisorRole> =
          cfg.lifecycle[state].advisors?.[0]?.role` (board.json's lifecycle for THIS state — e.g.
          `security-advisor` at `dev`, `code-reviewer` at `test` — **never hardcode a role name here**) —
          then route its verdict via the
          **Advisor verdict** rule above — `advice`/`clean` → `advice.mjs` (NOT "log only" — that was the
          clean-card livelock), `veto`/`hold` → `veto.mjs`/`hold.mjs`, `reject` → the **REJECT routing**
          rule below. A stage with no configured advisor skips this bullet entirely.
      - `status:"question"` → `node $S/escalate.mjs <id> "<the question>"` (park for a human).
        The verdict **must** carry the question text in `reason` (or `question`) — an ASK sets
        `blocked=true` and `not_blocked` is a gate predicate, so a question with no text blocks the
        card while giving the human nothing to answer. A reasonless `question` is treated as a
        malformed verdict: it still parks, but under a self-describing reason naming the role, stage
        and gen (GH #92).
        `"error"` / **no parseable block** → post nothing; log; retry next pass.
   4. **CLEAR_LEASE — always:** `node $S/clear-lease.mjs <id> <gen>` in **every** branch.
   5. Log a one-line outcome.
3. **Yield.** There is no pass counter and no context-clearing valve to maintain — this legacy
   in-session procedure just ends the pass; re-run via `/loop <interval> /yarradev:yarradev-run`
   (interval ≥ `pace.minLoopIntervalS`, default 5m; keep it under your prompt-cache TTL for cache hits).
   If you're running many passes in one long-lived interactive session and feel context pressure
   building, that's a signal to switch to the **headless `yarradev run` daemon** instead (`kdbx run --
   yarradev run`) — each of its ticks is a fresh, short-lived `pass.mjs` subprocess with nothing to
   accumulate, so this concern doesn't apply there at all.

## Discipline & safety
- **Bounded fan-out.** A card advances at most one stage per pass; the next pass re-reconciles. Each pass
  dispatches up to `effectiveK = min(pace.maxCardsPerPass, pace.maxConcurrent − in-flight)`. A gateway `529`
  (overloaded — surfaced by reconcile as `gateway_529`) trips a circuit breaker: OPEN → dispatch 0 for `breakerCooldownS`,
  then HALF_OPEN → one probe, then CLOSED on a clean pass. Set `maxCardsPerPass:1` to force single-threaded.
- **Never re-dispatch a card whose subagent is still running.** A long stage owner can outlast the lease
  (lease-TTL expiry bumps `current_gen`, so `dispatch-and-wait` times out near the TTL and you CLEAR_LEASE).
  `list-ready` then **skips** the card while its dispatch is `pending` with no `done` in the manifest
  (GH #27) — do not bypass that and reclaim it: the original subagent is still editing the worktree, and a
  second one would conflict. The card becomes reclaimable again once the subagent finishes (`done`) or the
  entry goes stale (~2h, `YDB_INFLIGHT_STALE_S`). (Recovering the timed-out verdict itself needs
  async-reconcile — GH #28.)
- **Process epics in priority order; finish one before starting the next.** `list-ready.mjs` emits
  cards sorted by (epic priority, card priority, id). Process the first actionable card in that
  order. Do not pick up a story from a different epic while the current epic has ready work.
- **Plugin bugs are not your job to fix.** If a script misbehaves (unexpected output shape, missing fields, crash), log it and escalate — do not silently work around it. Report it at https://github.com/yarradev/yarradev-board/issues/new so it gets fixed at the source.
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
| Dispatch | `dispatch-and-wait.mjs` non-zero exit (tool missing / dispatch failed / poll timeout) / subagent finished with no JSON verdict in `$V` | post nothing; **CLEAR_LEASE**; retry next pass. A poll-timeout (long subagent outlasted the lease) does NOT re-dispatch immediately — `list-ready` skips the card while its dispatch is `pending` (GH #27); it becomes reclaimable once the subagent finishes or the entry goes stale. (An empty `$V` after the wrapper returns is a real failure — the subagent produced no verdict.) |
| MOVE/REJECT | 409 fenced (lease/TTL expired mid-work) | **CLEAR_LEASE**; redo next pass |
| MOVE/REJECT/LINK_PR/PUSH | 422 gate_blocked / bad_act | **CLEAR_LEASE**; `decide` re-derives next pass (gate flipped → wait/respawn; budget → escalate; bounce → escalate). `blocked_by` is surfaced so you can branch on the failing predicate. |
| MOVE/CREATE (reconcile-time act, `reconcileVerdicts`) | posted act returns `!ok` (e.g. a 422 bad-act, or a crashed per-role token) — surfaced for **all load-bearing acts**: advance/reject MOVE, submitted link-pr/push, decomposed CREATE + barrier MOVE (`reattach-ci` and other best-effort acts stay non-fatal, never escalated) | **CLEAR_LEASE**; consume the verdict; surfaced as reconcile outcome `act_failed` — the card is **NOT** advanced. Distinct from `error` (reconcile machinery itself threw) and `routed` (success). Every load-bearing act failure **also escalates** (parks the card via `escalate.mjs`) so a deterministic failure can't loop forever re-dispatching — a human ANSWERs to unpark. |
| Verdict routing (`routeVerdict`) | the verdict parsed as JSON but its `status` is missing or not one of `advance`/`reject`/`submitted`/`decomposed`/`question`/`error`/`advice`/`clean`/`veto`/`hold` (a typo'd or hallucinated status) | **CLEAR_LEASE**; consume; **escalate** naming the offending status; surfaced as reconcile outcome `unknown_status` (GH #94). Distinct from `no-parse` (no fenced block at all) and from `routed` — before #94 this returned the success shape and was reported as `routed`, so an unroutable verdict looked like a healthy one and inflated the runner's verdict count. |
| CLEAR_LEASE | any | best-effort; the lease expires at its TTL anyway |

## Verify

**Headless (supported):** seed one card in `spec`, then `kdbx run -- yarradev run` (or
`YDB_TOKEN=<token> yarradev run` for a single-identity setup — never `export` it into your shell
profile). Watch `yarradev status` / `http://127.0.0.1:<port>/` as it ticks. It should move spec→dev
(designer) → dev→test (developer, gated on CI + security-advisor) → test→done (tester, gated on e2e +
code-reviewer — a `reject` bounces test→dev, `advice`/`clean` clears the gate) → done→staging (releaser
runs `deploy.staging`) → and park at `staging` awaiting a human GO; a `byKind:human` identity runs
`node $S/human-go.mjs <id>` and the next tick promotes staging→prod. Confirm `node $S/list-ready.mjs`
goes quiet and the card reads `state: prod`, then `yarradev stop`.

**Legacy in-session:** the same walk, driven by `/loop` instead of the daemon. Seed one card in `spec`;
give the orchestrator the board token **in your launch message** — it inlines it per call. Do **NOT**
`export` it: `/loop` dispatches role subagents in this same shell, so an exported token is inherited by
every subagent (readable via `printenv`) and a prompt-injected one could forge acts under your identity.
Then run `/loop 30s /yarradev:yarradev-run` and watch the same gate sequence as above.
