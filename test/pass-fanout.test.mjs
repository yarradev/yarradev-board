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
