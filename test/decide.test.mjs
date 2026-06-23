import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../skills/yarradev-board-run/scripts/decide.mjs";

const LC = {
  spec: { owner: "designer", to: "dev" },
  dev: { owner: "developer", to: "test" },
  test: { owner: "tester", to: "done" },
  done: { owner: "", to: null },
};
const card = (o = {}) => ({ id: "c1", state: "spec", blocked: false, current_gen: 0, lease_expiry_ts: null, ...o });

test("decide: works a ready card; noops on terminal/blocked/leased/unknown; expired lease is workable", () => {
  assert.deepEqual(decide(card({ state: "spec" }), LC, 1000), { kind: "work", role: "designer", to: "dev" });
  assert.deepEqual(decide(card({ state: "dev" }), LC, 1000), { kind: "work", role: "developer", to: "test" });
  assert.deepEqual(decide(card({ state: "done" }), LC, 1000), { kind: "noop", reason: "terminal" });
  assert.deepEqual(decide(card({ blocked: true }), LC, 1000), { kind: "noop", reason: "blocked" });
  assert.deepEqual(decide(card({ lease_expiry_ts: 2000 }), LC, 1000), { kind: "noop", reason: "leased" });
  assert.deepEqual(decide(card({ lease_expiry_ts: 500 }), LC, 1000), { kind: "work", role: "designer", to: "dev" });
  assert.deepEqual(decide(card({ state: "weird" }), LC, 1000), { kind: "noop", reason: "unknown-state" });
});
