/*
 * decide() — ported to drive the VENDORED orchestrator-core engine (skills/.../vendor/core.mjs).
 *
 * Migration notes (core is a superset of the old plugin decide, with a few deliberate upgrades):
 *  - Signature: OLD decide(card, lc, nowMs, budgets)  →  NEW decide(card, lifecycle, policy, nowMs).
 *    Budgets are sourced internally (DEFAULT_BUDGETS: transition_budget 50, respawn_window_ms 60000) —
 *    there is no budgets arg, so the budget scenarios below use the real defaults (50 / 60000ms).
 *  - decide() reads the EnrichedItem view, so card factories seed open_questions/vetoes/holds/
 *    next_transitions/children_* (the list projection omits these). This mirrors the real board
 *    invariants: a blocked card has an open question; a veto_held card has a veto flag.
 *  - Deliberate behavior UPGRADES vs the old plugin decide (each asserted + commented below):
 *      · unknown stage        → ESCALATE "unknown-stage: …"   (was noop "unknown-state")
 *      · expired lease        → RECLAIM role+to                (was work — reclaim = take over + re-dispatch)
 *      · blocked, no question  → ESCALATE board-drift          (would otherwise park forever)
 *      · veto_held, empty vetoes[] → PARK noop "veto-open"      (sticky-veto-after-reclaim; NOT drift —
 *                                                                the board can't produce out-of-band veto corruption)
 *      · transition budget checked BEFORE blocked (so blocked+over-budget escalates, not noops)
 *      · mechanical + advisor_clear still failing → WORK the advisor (advisor-clear routing)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decide } from "../skills/yarradev-board-run/scripts/vendor/core.mjs";

const POLICY = { advisors: [] }; // core.decide currently sources the advisor role from lifecycle, not policy
const Q = { q_seq: 1, cat: "escalation", deadline_ts: null, text: "waiting on a human" }; // an open question
const VETO = { role: "security-advisor" };

// enriched defaults so decide() never dereferences an undefined array
const enriched = (o) => ({
  open_questions: [], vetoes: [], holds: [], next_transitions: [],
  transitions_count: 0, children_total: 0, children_done: 0, ...o,
});

const LC = {
  spec: { owner: "designer", to: "dev" },
  dev: { owner: "developer", to: "test" },
  test: { owner: "tester", to: "done" },
  done: { owner: "", to: null },
};
const card = (o = {}) => enriched({ id: "c1", state: "spec", blocked: false, current_gen: 0, lease_expiry_ts: null, ...o });

test("decide (judgement): work a ready card; noop on terminal/blocked/leased; unknown escalates; expired lease reclaims", () => {
  assert.deepEqual(decide(card({ state: "spec" }), LC, POLICY, 1000), { kind: "work", role: "designer", to: "dev" });
  assert.deepEqual(decide(card({ state: "dev" }), LC, POLICY, 1000), { kind: "work", role: "developer", to: "test" });
  assert.deepEqual(decide(card({ state: "done" }), LC, POLICY, 1000), { kind: "noop", reason: "terminal" });
  // blocked WITH an open question → parked (the real invariant: ASK sets blocked + inserts a question row)
  assert.deepEqual(decide(card({ blocked: true, open_questions: [Q] }), LC, POLICY, 1000), { kind: "noop", reason: "blocked" });
  // leased (fresh) → noop
  assert.deepEqual(decide(card({ lease_expiry_ts: 2000 }), LC, POLICY, 1000), { kind: "noop", reason: "leased" });

  // UPGRADE: expired lease → reclaim (take over + re-dispatch the owner). Old plugin returned plain "work".
  assert.deepEqual(decide(card({ lease_expiry_ts: 500 }), LC, POLICY, 1000), { kind: "reclaim", role: "designer", to: "dev" });

  // UPGRADE: unknown stage → escalate (old plugin returned noop "unknown-state")
  const unknown = decide(card({ state: "weird" }), LC, POLICY, 1000);
  assert.equal(unknown.kind, "escalate");
  assert.match(unknown.reason, /unknown-stage/);

  // UPGRADE: blocked with NO open question → board-drift escalate (would otherwise park forever)
  const drift = decide(card({ blocked: true, open_questions: [] }), LC, POLICY, 1000);
  assert.equal(drift.kind, "escalate");
  assert.match(drift.reason, /board-drift/);
});

// Mechanical gate on `dev`: derive intent from (lease, linked_head_sha, ci_rollup).
const MLC = {
  spec: { owner: "designer", to: "dev" },
  dev: { owner: "developer", to: "test", gate: "mechanical" },
  test: { owner: "tester", to: "done" },
  done: { owner: "", to: null },
};
const mcard = (o = {}) => enriched({
  id: "m1", state: "dev", blocked: false, current_gen: 1, lease_expiry_ts: null,
  linked_head_sha: null, ci_rollup: "absent", ...o,
});

test("decide (mechanical dev): work/advance/respawn/wait by linked_head_sha + ci_rollup + lease", () => {
  // no PR yet -> spawn the developer
  assert.deepEqual(decide(mcard({ linked_head_sha: null }), MLC, POLICY, 1000), { kind: "work", role: "developer", to: "test" });
  // PR linked, CI pending/absent/blocked -> wait (no spawn, no advance)
  assert.deepEqual(decide(mcard({ linked_head_sha: "abc", ci_rollup: "pending" }), MLC, POLICY, 1000), { kind: "noop", reason: "ci-pending" });
  assert.deepEqual(decide(mcard({ linked_head_sha: "abc", ci_rollup: "absent" }), MLC, POLICY, 1000), { kind: "noop", reason: "ci-absent" });
  assert.deepEqual(decide(mcard({ linked_head_sha: "abc", ci_rollup: "blocked" }), MLC, POLICY, 1000), { kind: "noop", reason: "ci-blocked" });
  // CI green (no advisor gate still failing) -> advance (MOVE, no spawn)
  assert.deepEqual(decide(mcard({ linked_head_sha: "abc", ci_rollup: "success" }), MLC, POLICY, 1000), { kind: "advance", role: "developer", to: "test" });
  // CI red, no fresh lease -> respawn the developer to fix
  assert.deepEqual(decide(mcard({ linked_head_sha: "abc", ci_rollup: "failure" }), MLC, POLICY, 1000), { kind: "respawn", role: "developer" });
  // CI red BUT a fresh lease is held (developer actively fixing) -> wait; do NOT double-spawn
  assert.deepEqual(decide(mcard({ linked_head_sha: "abc", ci_rollup: "failure", lease_expiry_ts: 5000 }), MLC, POLICY, 1000), { kind: "noop", reason: "leased" });
  // governance `blocked` (with its question) overrides everything (distinct from ci_rollup "blocked")
  assert.deepEqual(decide(mcard({ blocked: true, open_questions: [Q], linked_head_sha: "abc", ci_rollup: "success" }), MLC, POLICY, 1000), { kind: "noop", reason: "blocked" });
  // terminal is still terminal
  assert.deepEqual(decide(mcard({ state: "done" }), MLC, POLICY, 1000), { kind: "noop", reason: "terminal" });
});

// UPGRADE: mechanical + CI green but the advisor_clear predicate is still failing → work the ADVISOR
const ALC = {
  dev: { owner: "developer", to: "test", gate: "mechanical", advisors: [{ role: "security-advisor" }] },
  test: { owner: "tester", to: "done" },
  done: { owner: "", to: null },
};
test("decide (mechanical + advisor): CI green but advisor_clear failing → dispatch the advisor, not advance", () => {
  const nt = [{ to: "test", type: "MOVE", failing: ["advisor_clear"], passing: ["ci_green"] }];
  assert.deepEqual(
    decide(mcard({ state: "dev", linked_head_sha: "abc", ci_rollup: "success", next_transitions: nt }), ALC, POLICY, 1000),
    { kind: "work", role: "security-advisor", to: "test" },
  );
  // advisor cleared (advisor_clear no longer in failing) → advance the owner
  const ntClear = [{ to: "test", type: "MOVE", failing: [], passing: ["ci_green", "advisor_clear"] }];
  assert.deepEqual(
    decide(mcard({ state: "dev", linked_head_sha: "abc", ci_rollup: "success", next_transitions: ntClear }), ALC, POLICY, 1000),
    { kind: "advance", role: "developer", to: "test" },
  );
});

test("decide (default budgets): transition-budget + ci-stall escalate; otherwise normal", () => {
  // transition budget reached (default 50) -> escalate (park for human)
  const overBudget = decide(card({ state: "spec", transitions_count: 50 }), LC, POLICY, 1000);
  assert.equal(overBudget.kind, "escalate");
  assert.match(overBudget.reason, /transition-budget/);
  // under budget -> normal work
  assert.deepEqual(decide(card({ state: "spec", transitions_count: 49 }), LC, POLICY, 1000), { kind: "work", role: "designer", to: "dev" });
  // mechanical CI failure within the respawn window (default 60000ms) -> respawn
  assert.deepEqual(decide(mcard({ linked_head_sha: "abc", ci_rollup: "failure", parked_since_ts: 900 }), MLC, POLICY, 1000), { kind: "respawn", role: "developer" });
  // mechanical CI failure past the respawn window -> escalate (ci-stalled)
  const stalled = decide(mcard({ linked_head_sha: "abc", ci_rollup: "failure", parked_since_ts: 0 }), MLC, POLICY, 60001);
  assert.equal(stalled.kind, "escalate");
  assert.match(stalled.reason, /ci-stalled/);
  // UPGRADE: budget is checked BEFORE blocked, so a blocked + over-budget card escalates (old: still noop "blocked")
  const blockedOverBudget = decide(card({ state: "spec", blocked: true, open_questions: [Q], transitions_count: 50 }), LC, POLICY, 1000);
  assert.equal(blockedOverBudget.kind, "escalate");
  assert.match(blockedOverBudget.reason, /transition-budget/);
});

test("decide (advisor): VETO/HOLD park the card; sticky-veto-after-reclaim parks (not board-drift); cleared resumes", () => {
  // VETO open (with its veto flag) dominates ci_green → parked
  assert.deepEqual(decide(mcard({ veto_held: true, vetoes: [VETO], linked_head_sha: "abc", ci_rollup: "success" }), MLC, POLICY, 1000), { kind: "noop", reason: "veto-open" });
  // Sticky veto after a lease-reclaim gen bump: veto_held=1 (item flag, not recomputed on reclaim) but
  // the GEN-SCOPED vetoes[] reads empty at the new gen. Platform PARKS (noop veto-open) — this is the
  // expected sticky-veto state, NOT board-drift. (v1 escalated out-of-band label corruption; the board
  // can't produce that — veto_held is fold-only. Post-merge max-effort review, 2026-07-02.)
  const stickyVeto = decide(mcard({ veto_held: true, vetoes: [], linked_head_sha: "abc", ci_rollup: "success" }), MLC, POLICY, 1000);
  assert.equal(stickyVeto.kind, "noop");
  assert.equal(stickyVeto.reason, "veto-open");
  // HOLD open → parked
  assert.deepEqual(decide(mcard({ hold_open: true, linked_head_sha: "abc", ci_rollup: "success" }), MLC, POLICY, 1000), { kind: "noop", reason: "hold-open" });
  // cleared (no veto/hold) + ci green → advance
  assert.deepEqual(decide(mcard({ linked_head_sha: "abc", ci_rollup: "success" }), MLC, POLICY, 1000), { kind: "advance", role: "developer", to: "test" });
});

const HLC = {
  test: { owner: "tester", to: "done" },
  done: { owner: "", to: "prod", gate: "human" },
  prod: { owner: "", to: null },
};
const hcard = (o = {}) => enriched({ id: "h1", state: "done", blocked: false, lease_expiry_ts: null, ...o });

test("decide (human gate): promote a human-gated stage; terminal + veto + blocked still dominate", () => {
  assert.deepEqual(decide(hcard(), HLC, POLICY, 1000), { kind: "promote", to: "prod" });
  assert.deepEqual(decide(hcard({ state: "prod" }), HLC, POLICY, 1000), { kind: "noop", reason: "terminal" });
  assert.deepEqual(decide(hcard({ veto_held: true, vetoes: [VETO] }), HLC, POLICY, 1000), { kind: "noop", reason: "veto-open" });
  assert.deepEqual(decide(hcard({ blocked: true, open_questions: [Q] }), HLC, POLICY, 1000), { kind: "noop", reason: "blocked" });
});

// Pin the SHIPPED config (config/board.example.json) — not a hand-written fixture — to decide(), so a
// state rename (prod→production) or a reshape of `done` (back to terminal) is caught by the suite.
const EXAMPLE = JSON.parse(
  readFileSync(new URL("../skills/yarradev-board-run/config/board.example.json", import.meta.url), "utf8")
);

test("decide (shipped board.example.json): full backlog→spec→dev→test→done→staging→prod lifecycle routes correctly", () => {
  const lc = EXAMPLE.lifecycle;
  assert.deepEqual(Object.keys(lc), ["backlog", "spec", "dev", "test", "done", "staging", "prod"]); // shape is pinned
  const c = (o) => enriched({ id: "x", blocked: false, lease_expiry_ts: null, current_gen: 1, ...o });
  // backlog: judgement intake stage (owner designer, to spec) → work the designer to spec
  assert.deepEqual(decide(c({ state: "backlog" }), lc, POLICY, 1000), { kind: "work", role: "designer", to: "spec" });
  // spec: judgement → designer
  assert.deepEqual(decide(c({ state: "spec" }), lc, POLICY, 1000), { kind: "work", role: "designer", to: "dev" });
  // dev: mechanical + advisor, no PR yet → work the developer
  assert.deepEqual(decide(c({ state: "dev", linked_head_sha: null }), lc, POLICY, 1000), { kind: "work", role: "developer", to: "test" });
  // dev: PR linked + CI green (no advisor_clear still failing in next_transitions) → advance, carrying the owner
  assert.deepEqual(decide(c({ state: "dev", linked_head_sha: "abc", ci_rollup: "success" }), lc, POLICY, 1000), { kind: "advance", role: "developer", to: "test" });
  // dev: vetoed despite green CI → advisor dominates (this park is load-bearing on the advance path)
  assert.deepEqual(decide(c({ state: "dev", linked_head_sha: "abc", ci_rollup: "success", veto_held: true, vetoes: [VETO] }), lc, POLICY, 1000), { kind: "noop", reason: "veto-open" });
  // test: judgement → tester
  assert.deepEqual(decide(c({ state: "test" }), lc, POLICY, 1000), { kind: "work", role: "tester", to: "done" });
  // done: judgement deploy-work stage → dispatch the releaser to deploy to staging
  assert.deepEqual(decide(c({ state: "done" }), lc, POLICY, 1000), { kind: "work", role: "releaser", to: "staging" });
  // staging: human-gated → promote to prod (the prod gate moved here from done)
  assert.deepEqual(decide(c({ state: "staging" }), lc, POLICY, 1000), { kind: "promote", to: "prod" });
  // staging: blocked/veto still dominate the human gate
  assert.deepEqual(decide(c({ state: "staging", blocked: true, open_questions: [Q] }), lc, POLICY, 1000), { kind: "noop", reason: "blocked" });
  assert.deepEqual(decide(c({ state: "staging", veto_held: true, vetoes: [VETO] }), lc, POLICY, 1000), { kind: "noop", reason: "veto-open" });
  // prod: terminal
  assert.deepEqual(decide(c({ state: "prod" }), lc, POLICY, 1000), { kind: "noop", reason: "terminal" });
});
