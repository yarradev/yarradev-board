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

test("decide (judgement): work a ready card; noop on terminal/blocked/leased/unknown; expired lease is workable", () => {
  assert.deepEqual(decide(card({ state: "spec" }), LC, 1000), { kind: "work", role: "designer", to: "dev" });
  assert.deepEqual(decide(card({ state: "dev" }), LC, 1000), { kind: "work", role: "developer", to: "test" });
  assert.deepEqual(decide(card({ state: "done" }), LC, 1000), { kind: "noop", reason: "terminal" });
  assert.deepEqual(decide(card({ blocked: true }), LC, 1000), { kind: "noop", reason: "blocked" });
  assert.deepEqual(decide(card({ lease_expiry_ts: 2000 }), LC, 1000), { kind: "noop", reason: "leased" });
  assert.deepEqual(decide(card({ lease_expiry_ts: 500 }), LC, 1000), { kind: "work", role: "designer", to: "dev" });
  assert.deepEqual(decide(card({ state: "weird" }), LC, 1000), { kind: "noop", reason: "unknown-state" });
});

// Mechanical gate on `dev`: derive intent from (lease, linked_head_sha, ci_rollup).
const MLC = {
  spec: { owner: "designer", to: "dev" },
  dev: { owner: "developer", to: "test", gate: "mechanical" },
  test: { owner: "tester", to: "done" },
  done: { owner: "", to: null },
};
const mcard = (o = {}) => ({
  id: "m1", state: "dev", blocked: false, current_gen: 1, lease_expiry_ts: null,
  linked_head_sha: null, ci_rollup: "absent", ...o,
});

test("decide (mechanical dev): work/advance/respawn/wait by linked_head_sha + ci_rollup + lease", () => {
  // no PR yet -> spawn the developer
  assert.deepEqual(decide(mcard({ linked_head_sha: null }), MLC, 1000), { kind: "work", role: "developer", to: "test" });
  // PR linked, CI pending/absent/blocked -> wait (no spawn, no advance)
  assert.deepEqual(decide(mcard({ linked_head_sha: "abc", ci_rollup: "pending" }), MLC, 1000), { kind: "noop", reason: "ci-pending" });
  assert.deepEqual(decide(mcard({ linked_head_sha: "abc", ci_rollup: "absent" }), MLC, 1000), { kind: "noop", reason: "ci-absent" });
  assert.deepEqual(decide(mcard({ linked_head_sha: "abc", ci_rollup: "blocked" }), MLC, 1000), { kind: "noop", reason: "ci-blocked" });
  // CI green -> advance (MOVE, no spawn)
  assert.deepEqual(decide(mcard({ linked_head_sha: "abc", ci_rollup: "success" }), MLC, 1000), { kind: "advance", to: "test" });
  // CI red, no fresh lease -> respawn the developer to fix
  assert.deepEqual(decide(mcard({ linked_head_sha: "abc", ci_rollup: "failure" }), MLC, 1000), { kind: "respawn", role: "developer" });
  // CI red BUT a fresh lease is held (developer actively fixing) -> wait; do NOT double-spawn (step-4 precedence)
  assert.deepEqual(decide(mcard({ linked_head_sha: "abc", ci_rollup: "failure", lease_expiry_ts: 5000 }), MLC, 1000), { kind: "noop", reason: "leased" });
  // governance `blocked` overrides everything (distinct from ci_rollup "blocked")
  assert.deepEqual(decide(mcard({ blocked: true, linked_head_sha: "abc", ci_rollup: "success" }), MLC, 1000), { kind: "noop", reason: "blocked" });
  // terminal is still terminal
  assert.deepEqual(decide(mcard({ state: "done" }), MLC, 1000), { kind: "noop", reason: "terminal" });
});
