# #39 — Multi-card fan-out with bounded, breaker-guarded concurrency

**Date:** 2026-07-08
**Issue:** [#39](https://github.com/yarradev/yarradev-board/issues/39) — Throughput: enable real multi-card fan-out (raise `pace.maxCardsPerPass > 1`, builds on #28)
**Status:** Design approved

## Problem

The fan-out *mechanism* is already built and shipped (#28) but pinned at the safe default `K = pace.maxCardsPerPass = 1`. This issue turns it on (`K > 1`), verifies concurrency safety at N>1, and bounds it against resource/rate limits.

## Concurrency-safety audit (issue part 1) — resolved

Board correctness is **safe by construction** at N>1. Every shared-state surface is isolated per-dispatch:

| Surface | Isolation at N>1 | Verdict |
|---|---|---|
| Board CLAIM / lease / gen | Per-card lease + gen; RECONCILE re-CLAIMs at verdict time (#27/#37) | safe |
| Verdict path (`tmpDir`) | `TMP_BASE/{role}-{cardId}-{pid}-{rand}/verdict.txt` — unique per dispatch (dispatch.mjs:429) | no collision |
| Worktree | `yarradev-<cardId>` — unique per card (dispatch.mjs:149) | no edit conflict |
| Dispatch manifest (`.jsonl`) | Parent `pending` appends sequential (dispatchNew awaits each); runner `done` appends are `appendFileSync` O_APPEND, one line ≪ PIPE_BUF → atomic | no corruption |
| Consumed / context ledgers | Written by parent pass only, sequential | safe |
| Selection | `list-ready` filters in-flight (in-flight.mjs) + server `deps_resolved` gate → selected set logically independent | safe by construction |
| Epic fan-in counters | Server-side DO, `all_children_terminal` barrier is transactional | board-side |

Residual risks are **load/economics, not correctness**:
1. **z.ai 529 thundering herd** — N concurrent `claude -p`, each retrying 529 on an uncoordinated 20→40→80s backoff.
2. **PR-merge conflicts** — logically-independent cards can still touch overlapping files (surfaces at merge, not runtime).
3. **Total in-flight ≠ K** — K bounds *new* dispatches per pass; in-flight accumulates across passes when cards outlive the pass interval. Real resource load is the total in-flight count.

## Scope correction

`pace` is **plugin-side only** — `plugin-io.mjs:54` deep-merges it into the conductor's local config; it is never POSTed to the board. Issue part 2's "re-apply board config via POST /boards" is a misconception: raising `maxCardsPerPass` is a one-line local `board.json` edit. The gate that makes fan-out safe (`deps_resolved`) is already live server-side.

⚠️ **Caveat:** `config-trust.mjs` merges platform `pace` **over** local per-key. If a platform config pins `maxCardsPerPass:1`, it overrides the local bump. Verify no platform pace override is in effect.

## Design

Two new **pure** functions (unit-testable, no I/O — matching `selectForDispatch`/`nextUnconsumedDone` style) + thin wiring in `pass.mjs` main(). No changes to the dispatch mechanism, board, or reconcile routing.

### 1. `computeEffectiveK({ K, maxConcurrent, inFlightCount, breakerState })` → number

- `CLOSED` → `max(0, min(K, maxConcurrent − inFlightCount))`
- `HALF_OPEN` → `max(0, min(1, maxConcurrent − inFlightCount))` — single probe
- `OPEN` → `0` — reconcile-only this pass

### 2. `advanceBreaker({ state, breakerUntil, saw529, now, cooldownS })` → `{ state, breakerUntil }`

Circuit breaker (cooldown + half-open), evaluated each pass **after** reconcile so `saw529` is known:

- `saw529` → **OPEN**, `breakerUntil = now + cooldownS` (trips/re-arms from any state)
- `OPEN` and `now ≥ breakerUntil` → **HALF_OPEN**
- `HALF_OPEN` and `!saw529` → **CLOSED**
- else unchanged

`saw529 = recResults.some(r => r.error_type === 'gateway_529')` (from the #44 error envelope surfaced by reconcile).

### Data flow in `pass.mjs` main()

1. Reconcile runs (unchanged) → `recResults`.
2. `saw529` computed from `recResults`.
3. Read persisted breaker state (`breaker.json` in `stateDir`) → `advanceBreaker(...)` → persist back.
4. `inFlightCount = inFlightCardIds(manifestContent, now, staleS).size` — reuse existing fn. Count is *prior* in-flight (this pass's dispatches aren't in the manifest yet), correctly reserving headroom.
5. `effectiveK = computeEffectiveK(...)`; pass to `dispatchNew` as `K`.
6. If `effectiveK === 0`, emit `{phase:"dispatch", action:"skipped", reason:"breaker-open"|"at-capacity"}` and skip dispatch.

### Config (`skills/yarradev-run/config/board.json`)

```jsonc
"pace": {
  "maxCardsPerPass": 3,
  "maxConcurrent": 4,
  "breakerCooldownS": 600,
  "claimTtlS": 1800,
  "minLoopIntervalS": 300
}
```

Code defaults keep it backward-compatible: `maxConcurrent ?? Infinity` (absent → today's behavior), `breakerCooldownS ?? 600`.

## Known limitation (accepted for v1)

`HALF_OPEN → CLOSED` can flip before the probe card actually reconciles (fire-and-forget latency), so a burst may go out one pass early. The re-arm-on-any-529 rule catches the fallout and `maxConcurrent` caps the overshoot. Full probe-correlation is deferred.

## Testing

New `test/pass-fanout.test.mjs`, table-driven, no live board/gh:
- `computeEffectiveK` — headroom clamp (inFlight ≥ maxConcurrent → 0), each breaker state, floor at 0.
- `advanceBreaker` — closed→open on 529, open→half-open at cooldown boundary, half-open→closed on clean pass, half-open→open re-arm on 529, cooldown boundary (`now` just below / at `breakerUntil`).

## Out of scope (YAGNI)

- **Cross-epic fairness knob** (issue part 3 "possibly") — `selectForDispatch` already does top-epic-first then cross-epic fill; no demonstrated need for a fairness weight.
- **PR-merge-conflict handling** — stays as-is; deps gate keeps cards logically independent, conflicts surface at merge.
- **Full probe correlation** for the breaker (see Known limitation).
