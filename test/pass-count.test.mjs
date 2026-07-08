/*
 * pass-count.test.mjs — GH #49: the 40-pass context-clear valve must advance on EVERY non-prep-clear pass
 * (including breaker-open / at-capacity skips), so a long gateway outage still trips prep-clear. Pure helper.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { advancePassCount } from "../skills/yarradev-run/scripts/pass.mjs";

test("increments the count and reports below-threshold", () => {
  assert.deepEqual(advancePassCount("5"), { next: 6, reachedThreshold: false });
});

test("reaches the threshold at the boundary (default 40)", () => {
  assert.deepEqual(advancePassCount("39"), { next: 40, reachedThreshold: true });
});

test("stays tripped past the threshold", () => {
  assert.deepEqual(advancePassCount("41"), { next: 42, reachedThreshold: true });
});

test("missing/empty/garbage content coerces to 0 → first pass is 1", () => {
  assert.deepEqual(advancePassCount(""), { next: 1, reachedThreshold: false });
  assert.deepEqual(advancePassCount(undefined), { next: 1, reachedThreshold: false });
  assert.deepEqual(advancePassCount("not-a-number"), { next: 1, reachedThreshold: false });
});

test("honors a custom threshold", () => {
  assert.deepEqual(advancePassCount("2", 3), { next: 3, reachedThreshold: true });
  assert.deepEqual(advancePassCount("1", 3), { next: 2, reachedThreshold: false });
});
