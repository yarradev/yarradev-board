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

const B = { transition_budget: 5, bounce_limit: 3, respawn_window_ms: 1000, per_edge_overrides: {} };

test("decide (budgets): transition-budget + ci-stall escalate; otherwise normal", () => {
  // transition budget reached (any non-terminal stage) -> escalate (park for human)
  assert.deepEqual(decide(card({ state: "spec", transitions_count: 5 }), LC, 1000, B), { kind: "escalate", reason: "transition-budget" });
  // under budget -> normal work
  assert.deepEqual(decide(card({ state: "spec", transitions_count: 4 }), LC, 1000, B), { kind: "work", role: "designer", to: "dev" });
  // mechanical CI failure within the respawn window -> respawn
  assert.deepEqual(decide(mcard({ linked_head_sha: "abc", ci_rollup: "failure", parked_since_ts: 900 }), MLC, 1000, B), { kind: "respawn", role: "developer" });
  // mechanical CI failure past the respawn window -> escalate (ci-stalled)
  assert.deepEqual(decide(mcard({ linked_head_sha: "abc", ci_rollup: "failure", parked_since_ts: 0 }), MLC, 2000, B), { kind: "escalate", reason: "ci-stalled" });
  // blocked (parked via ASK) is still skipped regardless of budget
  assert.deepEqual(decide(card({ state: "spec", blocked: true, transitions_count: 5 }), LC, 1000, B), { kind: "noop", reason: "blocked" });
});

test("decide (advisor): VETO/HOLD park the card; cleared resumes", () => {
  // VETO open dominates ci_green → parked
  assert.deepEqual(decide(mcard({ veto_held: true, linked_head_sha: "abc", ci_rollup: "success" }), MLC, 1000), { kind: "noop", reason: "veto-open" });
  // HOLD open → parked
  assert.deepEqual(decide(mcard({ hold_open: true, linked_head_sha: "abc", ci_rollup: "success" }), MLC, 1000), { kind: "noop", reason: "hold-open" });
  // cleared (no veto/hold) + ci green → advance
  assert.deepEqual(decide(mcard({ linked_head_sha: "abc", ci_rollup: "success" }), MLC, 1000), { kind: "advance", to: "test" });
});

const HLC = {
  test: { owner: "tester", to: "done" },
  done: { owner: "", to: "prod", gate: "human" },
  prod: { owner: "", to: null },
};
const hcard = (o = {}) => ({ id: "h1", state: "done", blocked: false, lease_expiry_ts: null, ...o });

test("decide (human gate): promote a human-gated stage; terminal + veto + blocked still dominate", () => {
  assert.deepEqual(decide(hcard(), HLC, 1000), { kind: "promote", to: "prod" });
  assert.deepEqual(decide(hcard({ state: "prod" }), HLC, 1000), { kind: "noop", reason: "terminal" });
  assert.deepEqual(decide(hcard({ veto_held: true }), HLC, 1000), { kind: "noop", reason: "veto-open" });
  assert.deepEqual(decide(hcard({ blocked: true }), HLC, 1000), { kind: "noop", reason: "blocked" });
});
