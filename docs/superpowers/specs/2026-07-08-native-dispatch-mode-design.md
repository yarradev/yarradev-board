# #51 — Native (in-session) dispatch mode for interactive Claude Code

**Date:** 2026-07-08
**Issue:** [#51](https://github.com/yarradev/yarradev-board/issues/51) — dispatch spawns an external `claude -p` process instead of the host's native subagent tool
**Status:** Design approved

## Problem

`dispatch.mjs` spawns role subagents as an **external OS process** running `claude -p` (`resolveClaudeBin()` → `spawnSync(claudeBin, ["-p", …])`). Two consequences:

1. **Invisible to the host's native subagent UI.** The subagent is a detached, unrelated OS process (`spawn(...).unref()`), so the orchestrating Claude Code session's native "subagent running" status-line indicator — which only tracks subagents spawned through the harness's own `Agent`/`Task` tool — has zero visibility. The only observability today is an ephemeral tmux window or reading the verdict file after the fact.
2. **Welded to the `claude` binary** (secondary; out of scope here — see below).

## Scope (locked during brainstorming)

- **Primary driver: interactive visibility.** Target is a continuous interactive Claude Code session; make role subagents show in the native status line and be steerable.
- **Preserve #39 bounded fan-out** in native mode (up to `K` background subagents per pass; `maxConcurrent` ceiling + 529 circuit breaker still apply).
- **`claude -p` stays** as the headless/cron fallback (unchanged default).
- **Out of scope:** cross-harness portability (opencode etc.) — the `dispatchMode` enum leaves room for a future backend without rework. Session-restart durability for native agents — native mode is for continuous sessions; a session that dies mid-agent relies on the existing in-flight `staleS` timeout to re-dispatch (documented, not engineered).

## Key architectural constraint

`pass.mjs` runs as a **Node subprocess** (`node $S/pass.mjs`, launched by the LLM conductor each pass). A Node subprocess **cannot call the host's native subagent tool** — `Agent`/`Task` is only available to the LLM session itself. So "dispatch natively" cannot be a spawn swapped inside `dispatch.mjs`; the actual `Agent`-tool call must be made by the **LLM conductor**.

## Design — pluggable dispatch *executor*, `pass.mjs` stays the single brain

All of #39's logic (selection, `decideDispatch`, breaker, `maxConcurrent`, reconcile, routing) stays exactly where it is. Only the **dispatch primitive** becomes pluggable:

- **External backend (today):** `pass.mjs`'s `dispatch()` spawns a detached `claude -p`; the runner writes the verdict file + `done` manifest entry.
- **Native backend (new):** `dispatch()` does **not** spawn. It writes the `pending` manifest entry, returns the verdict-file path, and **emits a `dispatch-request` line** on stdout (`{action:"dispatch-request", role, cardId, promptFile, verdictPath}`). The **LLM conductor** reads those lines, fires an `Agent(background)` call per request, and on each `task-notification` writes the agent's verdict into `verdictPath` + appends the `done` manifest entry — landing it exactly where `pass.mjs`'s existing reconcile already looks.

The two backends are **symmetric**: the only difference is *who produces the verdict file* — a detached `claude -p` (external) vs an `Agent`-tool subagent whose final message the conductor captures (native).

### Why this reuses everything
- **Reconcile** (`reconcileVerdicts` / `nextUnconsumedDone`) reads verdict files from the manifest — unchanged.
- **Routing** (`routeVerdict` / SKILL.md parity steps) — unchanged.
- **529 breaker** — the `Agent` subagent hits the same model gateway; a 529 lands in its output, the conductor writes it to the verdict file, reconcile classifies it `gateway_529`, the breaker trips. Works.
- **Bounds** (`decideDispatch` → `effectiveK`, `maxConcurrent`) — `pass.mjs` already emits at most `effectiveK` dispatch-requests, so the conductor naturally fires at most `effectiveK` background agents.

## Components

1. **`makeDispatch` / `dispatch.mjs`** — add a `native` mode. Instead of `spawnSync(claude -p …)`: write the `pending` manifest entry (same shape as external), mint the verdict path (same `tmpDir` scheme), emit the `dispatch-request` marker line on stdout, return the verdict path. Localized change; the external path is untouched.
2. **Mode selector** — `runtime.dispatchMode: "external" | "native"` in board config; **default `"external"`** (zero behavior change for every current deployment). `makeDispatch` reads it (threaded from `cfg.runtime?.dispatchMode`).
3. **SKILL.md — native per-pass protocol** (the bulk of the deliverable; a protocol doc, not engine code). When `dispatchMode: native`, per pass the conductor:
   1. runs `node $S/pass.mjs`;
   2. reads each `{action:"dispatch-request", …}` line from stdout;
   3. fires `Agent(background)` per line with the role + prompt file (subagent posts a verdict block as its final message);
   4. on each `task-notification`, writes the agent's final message to the request's `verdictPath` and appends the `done` manifest entry;
   5. lets the next reconcile pass route the landed verdicts (next-tick reconcile — see Decisions).
4. **Tests** — `makeDispatch` native mode: emits the correct `dispatch-request` shape, writes the `pending` entry, returns the verdict path, does NOT spawn (injectable spawn asserts no call). Reconcile/routing unchanged → no new tests there.

## Decisions

- **Reconcile cadence: next-tick.** Landed verdicts are picked up by the next `/loop` reconcile pass (simpler, consistent with external mode; up to one interval of latency). Not eager-kick-on-notification.
- **Default `dispatchMode: "external"`.** Native is strictly opt-in; current deployments are byte-identical.

## Data flow (native mode)

```
LLM conductor (continuous session)
  └─ each /loop tick:
       node pass.mjs
         ├─ reconcile prior verdict files (unchanged) → post acts
         ├─ decideDispatch → effectiveK
         └─ dispatchNew: for each selected card →
              CLAIM + build-prompt, write pending, emit
              {action:"dispatch-request", role, cardId, promptFile, verdictPath}
       conductor reads dispatch-request lines →
         Agent(background) per request
       on task-notification →
         write agent final message → verdictPath
         append done manifest entry
       (next tick: pass.mjs reconciles verdictPath → routes)
```

## Testing

- New `dispatch.mjs` native-mode unit tests (injected spawn + manifest writer): asserts request shape, pending-entry write, verdict-path return, and no spawn.
- Full suite stays green (reconcile/routing/breaker untouched).
- Manual: run the conductor interactively with `dispatchMode: native`, confirm role subagents appear in the status line and their verdicts route on the next pass.
