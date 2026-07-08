# #39 Bounded Fan-out Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn on multi-card fan-out (`pace.maxCardsPerPass > 1`) with a total-concurrency ceiling and a gateway-529 circuit breaker, so the conductor dispatches several cards per pass without corrupting board state or slamming an overloaded gateway.

**Architecture:** Three new **pure** functions in `pass.mjs` (`computeEffectiveK`, `advanceBreaker`, `decideDispatch`) compute this pass's dispatch budget from the reconcile results, the persisted breaker state, and the in-flight count. `pass.mjs` main() reads/writes a small `breaker.json` state file and passes the computed `effectiveK` to the existing `dispatchNew`. No changes to the dispatch mechanism, board, or reconcile routing — the fan-out loop already exists (#28), we're just bounding its input.

**Tech Stack:** Node ESM (built-ins only), `node:test` + `node:assert/strict`. Test runner: `npm test` (`node --test "test/*.test.mjs"`).

## Global Constraints

- **Zero external deps** — Node built-ins only (matches `pass.mjs` header line 22).
- **No top-level execution on import** — new functions are `export function`; CLI wiring stays inside the `import.meta.url === ...` guard (line 804).
- **Tests inject `now`** (epoch millis) and fixtures — no `Date.now()`, no live board, no `gh`, no manifest files (mirrors `test/in-flight.test.mjs`).
- **Backward-compatible config defaults** — `maxConcurrent ?? Infinity`, `breakerCooldownS ?? 600`; absent config ⇒ today's behavior.
- **Breaker states** are the exact string literals `"CLOSED"`, `"HALF_OPEN"`, `"OPEN"`.
- **`now` and `breakerUntil` are epoch milliseconds**; `cooldownS` is seconds (multiply by 1000 when adding).
- **529 signal key**: a reconcile result carries `error_type: "gateway_529"` (from #44) when the gateway shed the card.

---

### Task 1: `computeEffectiveK` — the headroom + breaker clamp

**Files:**
- Modify: `skills/yarradev-run/scripts/pass.mjs` (add exported function near `selectForDispatch`, after line 176)
- Test: `test/pass-fanout.test.mjs` (create)

**Interfaces:**
- Produces: `computeEffectiveK({ K:number, maxConcurrent:number, inFlightCount:number, breakerState:"CLOSED"|"HALF_OPEN"|"OPEN" }) => number`

- [ ] **Step 1: Write the failing tests**

Create `test/pass-fanout.test.mjs`:

```js
/*
 * pass-fanout.test.mjs — GH #39: bounded fan-out. Pure helpers, injected `now` (epoch ms), no I/O.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeEffectiveK, advanceBreaker, decideDispatch } from "../skills/yarradev-run/scripts/pass.mjs";

// ---- computeEffectiveK ----
test("CLOSED: clamps to per-pass K when headroom is ample", () => {
  assert.equal(computeEffectiveK({ K: 3, maxConcurrent: 10, inFlightCount: 0, breakerState: "CLOSED" }), 3);
});
test("CLOSED: clamps to remaining headroom below K", () => {
  assert.equal(computeEffectiveK({ K: 3, maxConcurrent: 4, inFlightCount: 2, breakerState: "CLOSED" }), 2);
});
test("CLOSED: at capacity → 0", () => {
  assert.equal(computeEffectiveK({ K: 3, maxConcurrent: 4, inFlightCount: 4, breakerState: "CLOSED" }), 0);
});
test("CLOSED: over capacity never negative", () => {
  assert.equal(computeEffectiveK({ K: 3, maxConcurrent: 4, inFlightCount: 6, breakerState: "CLOSED" }), 0);
});
test("CLOSED: maxConcurrent Infinity → just K", () => {
  assert.equal(computeEffectiveK({ K: 3, maxConcurrent: Infinity, inFlightCount: 99, breakerState: "CLOSED" }), 3);
});
test("HALF_OPEN: at most one probe, still headroom-clamped", () => {
  assert.equal(computeEffectiveK({ K: 3, maxConcurrent: 10, inFlightCount: 0, breakerState: "HALF_OPEN" }), 1);
  assert.equal(computeEffectiveK({ K: 3, maxConcurrent: 4, inFlightCount: 4, breakerState: "HALF_OPEN" }), 0);
});
test("OPEN: dispatch nothing", () => {
  assert.equal(computeEffectiveK({ K: 3, maxConcurrent: 10, inFlightCount: 0, breakerState: "OPEN" }), 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="computeEffectiveK|CLOSED|HALF_OPEN|OPEN"` (or `npm test`)
Expected: FAIL — `computeEffectiveK` is not exported (import throws / `undefined is not a function`).

- [ ] **Step 3: Write the implementation**

In `skills/yarradev-run/scripts/pass.mjs`, immediately after `selectForDispatch` (after line 176), add:

```js
/**
 * How many NEW cards to dispatch this pass. Pure. Combines the per-pass rate limit K, the total-in-flight
 * ceiling maxConcurrent, the count already in-flight, and the circuit-breaker state:
 *   - "CLOSED"    → min(K, maxConcurrent − inFlightCount), floored at 0 (normal fan-out)
 *   - "HALF_OPEN" → at most 1 (single probe after cooldown), still headroom-clamped
 *   - "OPEN"      → 0 (reconcile-only; gateway is shedding load)
 * @param {{K:number, maxConcurrent:number, inFlightCount:number, breakerState:"CLOSED"|"HALF_OPEN"|"OPEN"}} o
 * @returns {number}
 */
export function computeEffectiveK({ K, maxConcurrent, inFlightCount, breakerState }) {
  if (breakerState === "OPEN") return 0;
  const cap = breakerState === "HALF_OPEN" ? 1 : K;
  return Math.max(0, Math.min(cap, maxConcurrent - inFlightCount));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: the 7 `computeEffectiveK` assertions PASS (the `advanceBreaker`/`decideDispatch` imports still resolve to `undefined` — their tests are added in Tasks 2–3; if `npm test` fails only on those, that's expected until Task 3).

> Note: because all three functions are imported at the top of the one test file, run the full file only after Task 3, or scope with `--test-name-pattern` per task. Use the pattern flag for Steps 2/4 here.

- [ ] **Step 5: Commit**

```bash
git add skills/yarradev-run/scripts/pass.mjs test/pass-fanout.test.mjs
git commit -m "feat(pass): computeEffectiveK — headroom + breaker dispatch clamp (#39)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `advanceBreaker` — the 529 circuit-breaker state machine

**Files:**
- Modify: `skills/yarradev-run/scripts/pass.mjs` (add exported function after `computeEffectiveK`)
- Test: `test/pass-fanout.test.mjs` (extend)

**Interfaces:**
- Consumes: nothing from Task 1 (independent pure fn).
- Produces: `advanceBreaker({ state:"CLOSED"|"HALF_OPEN"|"OPEN", breakerUntil:number, saw529:boolean, now:number, cooldownS:number }) => { state, breakerUntil }`

- [ ] **Step 1: Write the failing tests**

Append to `test/pass-fanout.test.mjs`:

```js
// ---- advanceBreaker ---- (now/breakerUntil are epoch ms; cooldownS in seconds)
const T0 = Date.UTC(2026, 6, 8, 12, 0, 0); // fixed clock
const COOLDOWN_S = 600;

test("CLOSED + 529 → OPEN, arms cooldown", () => {
  const b = advanceBreaker({ state: "CLOSED", breakerUntil: 0, saw529: true, now: T0, cooldownS: COOLDOWN_S });
  assert.deepEqual(b, { state: "OPEN", breakerUntil: T0 + COOLDOWN_S * 1000 });
});
test("CLOSED + clean → stays CLOSED", () => {
  assert.deepEqual(
    advanceBreaker({ state: "CLOSED", breakerUntil: 0, saw529: false, now: T0, cooldownS: COOLDOWN_S }),
    { state: "CLOSED", breakerUntil: 0 },
  );
});
test("OPEN before cooldown expiry → stays OPEN", () => {
  const until = T0 + COOLDOWN_S * 1000;
  assert.deepEqual(
    advanceBreaker({ state: "OPEN", breakerUntil: until, saw529: false, now: T0 + 1000, cooldownS: COOLDOWN_S }),
    { state: "OPEN", breakerUntil: until },
  );
});
test("OPEN at cooldown expiry → HALF_OPEN", () => {
  const until = T0 + COOLDOWN_S * 1000;
  assert.deepEqual(
    advanceBreaker({ state: "OPEN", breakerUntil: until, saw529: false, now: until, cooldownS: COOLDOWN_S }),
    { state: "HALF_OPEN", breakerUntil: until },
  );
});
test("HALF_OPEN + clean → CLOSED (probe survived)", () => {
  assert.deepEqual(
    advanceBreaker({ state: "HALF_OPEN", breakerUntil: T0, saw529: false, now: T0 + 5000, cooldownS: COOLDOWN_S }),
    { state: "CLOSED", breakerUntil: T0 },
  );
});
test("HALF_OPEN + 529 → re-arm OPEN", () => {
  const now = T0 + 5000;
  assert.deepEqual(
    advanceBreaker({ state: "HALF_OPEN", breakerUntil: T0, saw529: true, now, cooldownS: COOLDOWN_S }),
    { state: "OPEN", breakerUntil: now + COOLDOWN_S * 1000 },
  );
});
test("missing breakerUntil defaults to 0", () => {
  const b = advanceBreaker({ state: "CLOSED", saw529: false, now: T0, cooldownS: COOLDOWN_S });
  assert.deepEqual(b, { state: "CLOSED", breakerUntil: 0 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="OPEN|HALF_OPEN|CLOSED|breakerUntil"`
Expected: FAIL — `advanceBreaker` is not a function.

- [ ] **Step 3: Write the implementation**

In `pass.mjs`, immediately after `computeEffectiveK`, add:

```js
/**
 * Advance the 529 circuit breaker one step. Evaluated each pass AFTER reconcile, so `saw529` reflects this
 * pass's reconciled verdicts. Cooldown + half-open semantics (now/breakerUntil epoch ms, cooldownS seconds):
 *   - saw529 (from ANY state)      → OPEN, breakerUntil = now + cooldownS*1000 (trip / re-arm)
 *   - OPEN and now ≥ breakerUntil  → HALF_OPEN (allow one probe next pass)
 *   - HALF_OPEN and !saw529        → CLOSED (probe pass came back clean)
 *   - otherwise                    → unchanged
 * Pure — no clock read, no I/O.
 * @param {{state:"CLOSED"|"HALF_OPEN"|"OPEN", breakerUntil?:number, saw529:boolean, now:number, cooldownS:number}} o
 * @returns {{state:"CLOSED"|"HALF_OPEN"|"OPEN", breakerUntil:number}}
 */
export function advanceBreaker({ state, breakerUntil = 0, saw529, now, cooldownS }) {
  if (saw529) return { state: "OPEN", breakerUntil: now + cooldownS * 1000 };
  if (state === "OPEN" && now >= breakerUntil) return { state: "HALF_OPEN", breakerUntil };
  if (state === "HALF_OPEN") return { state: "CLOSED", breakerUntil };
  return { state, breakerUntil };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="OPEN|HALF_OPEN|CLOSED|breakerUntil"`
Expected: PASS (all 7 `advanceBreaker` assertions).

- [ ] **Step 5: Commit**

```bash
git add skills/yarradev-run/scripts/pass.mjs test/pass-fanout.test.mjs
git commit -m "feat(pass): advanceBreaker — 529 cooldown+half-open circuit breaker (#39)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `decideDispatch` — compose breaker + budget from reconcile results

**Files:**
- Modify: `skills/yarradev-run/scripts/pass.mjs` (add exported function after `advanceBreaker`)
- Test: `test/pass-fanout.test.mjs` (extend)

**Interfaces:**
- Consumes: `computeEffectiveK`, `advanceBreaker` (Tasks 1–2).
- Produces: `decideDispatch({ recResults:Array<{error_type?:string}>, prevBreaker:{state,breakerUntil}, inFlightCount:number, K:number, maxConcurrent:number, cooldownS:number, now:number }) => { effectiveK:number, breaker:{state,breakerUntil}, saw529:boolean }`

- [ ] **Step 1: Write the failing tests**

Append to `test/pass-fanout.test.mjs`:

```js
// ---- decideDispatch ----
const CLOSED0 = { state: "CLOSED", breakerUntil: 0 };

test("decideDispatch: clean reconcile, headroom → full K, stays CLOSED", () => {
  const d = decideDispatch({
    recResults: [{ outcome: "advanced" }, { outcome: "skipped" }],
    prevBreaker: CLOSED0, inFlightCount: 1, K: 3, maxConcurrent: 4, cooldownS: 600, now: T0,
  });
  assert.equal(d.saw529, false);
  assert.equal(d.effectiveK, 3); // min(3, 4-1)
  assert.equal(d.breaker.state, "CLOSED");
});
test("decideDispatch: a gateway_529 trips OPEN and forces effectiveK 0", () => {
  const d = decideDispatch({
    recResults: [{ outcome: "advanced" }, { outcome: "dispatch_error", error_type: "gateway_529" }],
    prevBreaker: CLOSED0, inFlightCount: 0, K: 3, maxConcurrent: 4, cooldownS: 600, now: T0,
  });
  assert.equal(d.saw529, true);
  assert.equal(d.breaker.state, "OPEN");
  assert.equal(d.breaker.breakerUntil, T0 + 600 * 1000);
  assert.equal(d.effectiveK, 0);
});
test("decideDispatch: OPEN past cooldown → HALF_OPEN, one probe", () => {
  const d = decideDispatch({
    recResults: [],
    prevBreaker: { state: "OPEN", breakerUntil: T0 }, inFlightCount: 0, K: 3, maxConcurrent: 4, cooldownS: 600, now: T0 + 1,
  });
  assert.equal(d.breaker.state, "HALF_OPEN");
  assert.equal(d.effectiveK, 1);
});
test("decideDispatch: undefined recResults treated as no 529", () => {
  const d = decideDispatch({
    recResults: undefined, prevBreaker: CLOSED0, inFlightCount: 4, K: 3, maxConcurrent: 4, cooldownS: 600, now: T0,
  });
  assert.equal(d.saw529, false);
  assert.equal(d.effectiveK, 0); // at capacity
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="decideDispatch"`
Expected: FAIL — `decideDispatch` is not a function.

- [ ] **Step 3: Write the implementation**

In `pass.mjs`, immediately after `advanceBreaker`, add:

```js
/**
 * Decide this pass's dispatch budget: reduce the 529 signal from reconcile results, advance the breaker, then
 * compute effectiveK. Pure — composes advanceBreaker + computeEffectiveK; main() supplies the I/O (read/write
 * the breaker state file, count in-flight).
 * @param {{recResults:Array<{error_type?:string}>|undefined, prevBreaker:{state:string,breakerUntil:number},
 *          inFlightCount:number, K:number, maxConcurrent:number, cooldownS:number, now:number}} o
 * @returns {{effectiveK:number, breaker:{state:string,breakerUntil:number}, saw529:boolean}}
 */
export function decideDispatch({ recResults, prevBreaker, inFlightCount, K, maxConcurrent, cooldownS, now }) {
  const saw529 = Array.isArray(recResults) && recResults.some((r) => r?.error_type === "gateway_529");
  const breaker = advanceBreaker({ ...prevBreaker, saw529, now, cooldownS });
  const effectiveK = computeEffectiveK({ K, maxConcurrent, inFlightCount, breakerState: breaker.state });
  return { effectiveK, breaker, saw529 };
}
```

- [ ] **Step 4: Run the full test file**

Run: `npm test`
Expected: PASS — entire `pass-fanout.test.mjs` (all three functions) plus every pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add skills/yarradev-run/scripts/pass.mjs test/pass-fanout.test.mjs
git commit -m "feat(pass): decideDispatch — compose 529 breaker + concurrency budget (#39)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Wire into main(), raise config, document, bump version

**Files:**
- Modify: `skills/yarradev-run/scripts/pass.mjs` (import; `BREAKER_NAME` const; main() wiring lines ~845–962)
- Modify: `skills/yarradev-run/config/board.json` (raise pace, add ceiling + breaker)
- Modify: `skills/yarradev-run/config/board.example.json` (add the new pace keys)
- Modify: `skills/yarradev-run/SKILL.md` (lines 97, 148, 441 — fan-out description)
- Modify: `.claude-plugin/plugin.json` (version 0.11.0 → 0.12.0)

**Interfaces:**
- Consumes: `decideDispatch` (Task 3), `inFlightCardIds` (from `./in-flight.mjs`), existing `dispatchNew`, `readIfPresent`, `stateDir`, `manifestContent`, `recResults`, `K`.
- Produces: nothing new for later tasks (terminal wiring task).

- [ ] **Step 1: Verify no platform pace override shadows the bump**

Run: `grep -rn "maxCardsPerPass" . --include=*.json | grep -v graphify-out; ls .yarradev/board.json 2>/dev/null || echo "no project .yarradev/board.json"`
Expected: only `skills/yarradev-run/config/board.json` and `board.example.json` match; no committed platform/project override pinning `maxCardsPerPass:1`. If a project `.yarradev/board.json` exists with a `pace.maxCardsPerPass`, note it — `config-trust.mjs` merges platform pace **over** local, so it would shadow this change (flag to the reviewer, do not silently override).

- [ ] **Step 2: Add the import and the state-file constant**

In `pass.mjs`, after line 29 (`import { loadConfig } from "./plugin-io.mjs";`) add:

```js
import { inFlightCardIds } from "./in-flight.mjs";
```

After line 40 (`const CONTEXT_NAME = "dispatch-context.jsonl";`) add:

```js
const BREAKER_NAME = "dispatch-breaker.json";
```

- [ ] **Step 3: Read config knobs where `K` is read**

In `pass.mjs`, replace the block at lines 808–809:

```js
  const K = cfg.pace?.maxCardsPerPass ?? 1;
  const ttlS = cfg.pace?.claimTtlS ?? 1800;
```

with:

```js
  const K = cfg.pace?.maxCardsPerPass ?? 1;
  const ttlS = cfg.pace?.claimTtlS ?? 1800;
  const maxConcurrent = cfg.pace?.maxConcurrent ?? Infinity;
  const breakerCooldownS = cfg.pace?.breakerCooldownS ?? 600;
  const inflightStaleS = Number(cfg.runtime?.inflightStaleS ?? 7200);
```

- [ ] **Step 4: Compute the dispatch budget after reconcile**

In `pass.mjs`, immediately after the reconcile-results loop that ends at line 871 (`  }` closing `for (const r of recResults)`), and before the `// --- Phase 2: list ready cards ...` comment (line 873), insert:

```js
  // --- 529 circuit breaker + total-concurrency bound (GH #39) ---
  const breakerPath = join(stateDir, BREAKER_NAME);
  const nowMs = Date.now();
  let prevBreaker = { state: "CLOSED", breakerUntil: 0 };
  try {
    const raw = readIfPresent(breakerPath);
    if (raw) prevBreaker = { state: "CLOSED", breakerUntil: 0, ...JSON.parse(raw) };
  } catch {
    /* corrupt breaker file → default CLOSED */
  }
  const inFlightCount = inFlightCardIds(manifestContent, nowMs, inflightStaleS).size;
  const { effectiveK, breaker, saw529 } = decideDispatch({
    recResults, prevBreaker, inFlightCount, K, maxConcurrent, cooldownS: breakerCooldownS, now: nowMs,
  });
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(breakerPath, JSON.stringify(breaker));
  } catch (e) {
    process.stderr.write(`[pass] breaker persist failed: ${e?.message ?? e} (non-fatal)\n`);
  }
  if (breaker.state !== "CLOSED" || saw529) {
    process.stderr.write(
      `[pass] breaker ${breaker.state} (saw529=${saw529}, inFlight=${inFlightCount}/${maxConcurrent}, effectiveK=${effectiveK})\n`,
    );
  }
```

- [ ] **Step 5: Use `effectiveK` in the Phase 2b dispatch branch**

In `pass.mjs`, replace the dispatch branch at lines 932–947. The current code is:

```js
  if (skipDispatch) {
    process.stdout.write(JSON.stringify({ phase: "dispatch", action: "skipped", reason: "prep-clear" }) + "\n");
  } else {
    const dispatchOut = await dispatchNew({
      cards: dispatchCards,
      K,
      epicOf,
      run,
      dispatch,
      ttlS,
      writeContext: (verdictPath, ctx) => {
        mkdirSync(stateDir, { recursive: true });
        appendFileSync(contextPath, JSON.stringify({ verdictPath, ctx, recordedAt: new Date().toISOString() }) + "\n");
      },
    });
    process.stdout.write(JSON.stringify({ phase: "dispatch", ...dispatchOut }) + "\n");
```

Replace the `if (skipDispatch) { ... } else {` header (keeping the `dispatchNew` body and everything after it inside the final `else` unchanged) with a three-way branch — change `K,` to `K: effectiveK,`:

```js
  if (skipDispatch) {
    process.stdout.write(JSON.stringify({ phase: "dispatch", action: "skipped", reason: "prep-clear" }) + "\n");
  } else if (effectiveK <= 0) {
    const reason = breaker.state === "OPEN" ? "breaker-open" : "at-capacity";
    process.stdout.write(
      JSON.stringify({ phase: "dispatch", action: "skipped", reason, inFlightCount, breakerState: breaker.state }) + "\n",
    );
  } else {
    const dispatchOut = await dispatchNew({
      cards: dispatchCards,
      K: effectiveK,
      epicOf,
      run,
      dispatch,
      ttlS,
      writeContext: (verdictPath, ctx) => {
        mkdirSync(stateDir, { recursive: true });
        appendFileSync(contextPath, JSON.stringify({ verdictPath, ctx, recordedAt: new Date().toISOString() }) + "\n");
      },
    });
    process.stdout.write(JSON.stringify({ phase: "dispatch", ...dispatchOut }) + "\n");
```

Leave the pass-count fallback block (lines 949–961) and the closing `}` exactly as they are — it stays inside this final `else`, so a breaker-open/at-capacity pass does not increment the 40-pass counter (acceptable: that pass did no dispatch work).

- [ ] **Step 6: Raise the live config**

In `skills/yarradev-run/config/board.json`, replace the `pace` line:

```json
  "pace": { "maxCardsPerPass": 1, "claimTtlS": 1800, "minLoopIntervalS": 300 },
```

with:

```json
  "pace": { "maxCardsPerPass": 3, "maxConcurrent": 4, "breakerCooldownS": 600, "claimTtlS": 1800, "minLoopIntervalS": 300 },
```

- [ ] **Step 7: Surface the new knobs in the template**

In `skills/yarradev-run/config/board.example.json`, replace the `pace` line:

```json
  "pace": { "maxCardsPerPass": 1, "claimTtlS": 1800, "minLoopIntervalS": 300 },
```

with (template stays conservative at 1, but shows the ceiling + breaker knobs):

```json
  "pace": { "maxCardsPerPass": 1, "maxConcurrent": 4, "breakerCooldownS": 600, "claimTtlS": 1800, "minLoopIntervalS": 300 },
```

- [ ] **Step 8: Update SKILL.md fan-out documentation**

In `skills/yarradev-run/SKILL.md`:

Line 97 — replace:
```
> lease-TTL gen-bumps — fixes #27's recovery gap), **fans out** ≤`pace.maxCardsPerPass` concurrent dispatches
```
with:
```
> lease-TTL gen-bumps — fixes #27's recovery gap), **fans out** up to `effectiveK` concurrent dispatches —
> `min(pace.maxCardsPerPass, pace.maxConcurrent − in-flight)`, dropped to 0/1 by the 529 circuit breaker
```

Line 148 — replace:
```
2. **For each actionable card, sequentially, up to `pace.maxCardsPerPass` (default 1), branch on `kind`:**
```
with:
```
2. **For each actionable card, sequentially, up to `effectiveK` (≤ `pace.maxCardsPerPass`, default 3), branch on `kind`:**
```

Line 440–441 — replace:
```
- **One subagent per card per pass.** A card advances at most one stage per pass; the next pass
  re-reconciles. `maxCardsPerPass:1` keeps it single-threaded.
```
with:
```
- **Bounded fan-out.** A card advances at most one stage per pass; the next pass re-reconciles. Each pass
  dispatches up to `effectiveK = min(pace.maxCardsPerPass, pace.maxConcurrent − in-flight)`. A gateway `529`
  (overloaded — surfaced by reconcile as `gateway_529`) trips a circuit breaker: OPEN → dispatch 0 for `breakerCooldownS`,
  then HALF_OPEN → one probe, then CLOSED on a clean pass. Set `maxCardsPerPass:1` to force single-threaded.
```

- [ ] **Step 9: Bump the plugin version**

In `.claude-plugin/plugin.json`, change `"version": "0.11.0",` to `"version": "0.12.0",`.

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: PASS — all pre-existing tests plus `pass-fanout.test.mjs`. Confirm `pass-dispatch.test.mjs`, `pass-reconcile.test.mjs`, `pass-routing.test.mjs`, `pass-sync.test.mjs`, and `in-flight.test.mjs` are all green (the wiring changed only what `K` value flows into `dispatchNew`, which those tests inject directly, so they must remain unaffected).

- [ ] **Step 11: Sanity-check the module imports cleanly**

Run: `node -e "import('./skills/yarradev-run/scripts/pass.mjs').then(m => console.log(typeof m.computeEffectiveK, typeof m.advanceBreaker, typeof m.decideDispatch))"`
Expected: `function function function` and no top-level execution / crash (proves the CLI body stays guarded and the new import resolves).

- [ ] **Step 12: Commit**

```bash
git add skills/yarradev-run/scripts/pass.mjs skills/yarradev-run/config/board.json \
  skills/yarradev-run/config/board.example.json skills/yarradev-run/SKILL.md .claude-plugin/plugin.json
git commit -m "feat(pass): enable bounded multi-card fan-out — K=3, maxConcurrent + 529 breaker (#39, v0.12.0)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Concurrency-safety audit (part 1) → resolved in the spec; no code needed (isolation primitives already hold). ✅
- Raise `maxCardsPerPass` (part 2) → Task 4 Step 6; scope-corrected (plugin-side, no board POST) — Step 1 verifies no platform override. ✅
- Bound it (part 3): total-concurrency ceiling → `computeEffectiveK` (Task 1) + `maxConcurrent` config (Task 4); 529 backoff/breaker → `advanceBreaker` (Task 2) wired in Task 4. ✅
- Cross-epic fairness → explicitly out of scope (YAGNI) per spec. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full code; every command has expected output. ✅

**Type consistency:** `computeEffectiveK`/`advanceBreaker`/`decideDispatch` signatures and the `{state, breakerUntil}` shape, `"gateway_529"` key, `"CLOSED"|"HALF_OPEN"|"OPEN"` literals, and `now`/`breakerUntil` (ms) vs `cooldownS` (s) are used identically across Tasks 1–4 and the wiring. `inFlightCardIds(manifestContent, nowMs, inflightStaleS).size` matches its signature in `in-flight.mjs`. ✅
