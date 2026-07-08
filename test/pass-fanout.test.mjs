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
