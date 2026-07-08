/*
 * pass-routing.test.mjs — #28. THE parity contract. routeVerdict must match SKILL.md step 2/3 (the PARSE
 * step's verdict→act mapping) EXACTLY — this test is the table that pins that mapping to deterministic code.
 *
 * Every verdict shape gets a case asserting routeVerdict calls EXACTLY the expected act scripts with the
 * expected args. `run` / `dispatch` / `getCard` / `buildAdvisorPrompt` are injected mocks — no real board,
 * no gh, no spawn. routeVerdict records its own `acts` list; assertions are over that.
 *
 * Source of truth: skills/yarradev-run/SKILL.md (the per-kind routing + PARSE step). The async reshape
 * (spec §Routing parity): the same-pass inline advisor (422 blocked_by ⊇ advisor_clear) becomes a
 * fire-and-forget advisor dispatch reconciled NEXT pass — see the "422 advisor_clear" case.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeVerdict, rejectTargetOf } from "../skills/yarradev-run/scripts/pass.mjs";

// ---- mock factories -------------------------------------------------------------

/** Build an injected `run(script, args)` that returns canned results per script (default: committed). */
function makeRun(perScript = {}) {
  return async (script, args) => {
    const r = perScript[script];
    if (typeof r === "function") return r(args);
    return r ?? { ok: true, status: 202, outcome: "committed" };
  };
}

const COMMITTED_MOVE = { ok: true, status: 202, outcome: "committed" };
const NO_CARD = async () => null; // getCard: every bug id is absent (no dedup hits)

/**
 * Run one verdict through routeVerdict with sensible default deps and return its recorded acts
 * (normalized to [script, args] pairs) + dispatches. `overrides` swaps any dep or lifecycle/machine.
 */
async function route({ verdict, ctx, overrides = {} }) {
  const lifecycle = overrides.lifecycle ?? {
    test: { advisors: [{ role: "code-reviewer" }] },
    dev: { advisors: [{ role: "security-advisor" }] },
  };
  const machine = overrides.machine ?? { transitions: [{ from: "test", type: "REJECT", to: "dev" }] };
  const dispatch = overrides.dispatch ?? (() => "/v/dispatched");
  const buildAdvisorPrompt = overrides.buildAdvisorPrompt ?? ((c, role) => `/tmp/yarradev-prompt-${c.id}.txt`);
  const result = await routeVerdict({
    verdict,
    ctx,
    lifecycle,
    machine,
    run: overrides.run ?? makeRun(),
    dispatch,
    getCard: overrides.getCard ?? NO_CARD,
    buildAdvisorPrompt,
  });
  return {
    acts: result.acts.map((a) => [a.script, a.args]),
    dispatches: result.dispatches,
    advisorClear422: result.advisorClear422,
    actFailed: result.actFailed ?? null,
    raw: result,
  };
}

// ---- table-driven parity: one case per verdict shape ---------------------------

const CASES = [
  {
    name: "worker advance (no summary) → move only, no note",
    verdict: { status: "advance" },
    ctx: { id: "c1", state: "spec", role: "designer", to: "dev", gen: 3, kind: "work" },
    expect: [["move.mjs", ["c1", 3, "dev", "designer"]]],
  },
  {
    name: "worker advance + summary/evidence → move THEN note (gen-exempt)",
    verdict: { status: "advance", summary: "plan: split module", evidence: "see doc X" },
    ctx: { id: "c1", state: "spec", role: "designer", to: "dev", gen: 3, kind: "work" },
    expect: [
      ["move.mjs", ["c1", 3, "dev", "designer"]],
      // note text shape from SKILL.md: "[<role>→<to>] <summary> <evidence>"
      ["note.mjs", ["c1", "[designer→dev] plan: split module see doc X"]],
    ],
  },
  {
    name: "worker advance + summary but NO evidence → note with summary only",
    verdict: { status: "advance", summary: "plan only" },
    ctx: { id: "c1", state: "spec", role: "designer", to: "dev", gen: 3, kind: "work" },
    expect: [
      ["move.mjs", ["c1", 3, "dev", "designer"]],
      ["note.mjs", ["c1", "[designer→dev] plan only"]],
    ],
  },
  {
    name: "worker reject (carries verdict.to) → reject under stage owner",
    verdict: { status: "reject", to: "dev", reason: "tests red" },
    ctx: { id: "c1", state: "test", role: "tester", to: "done", gen: 5, kind: "work" },
    expect: [["reject.mjs", ["c1", 5, "dev", "tester"]]],
  },
  {
    name: "submitted + kind:work (first submission) → link-pr THEN reattach-ci",
    verdict: { status: "submitted", evidence: { repo: "acme/main", pr_number: 42, head: "abc123sha" } },
    ctx: { id: "c1", state: "dev", role: "developer", to: "test", gen: 4, kind: "work" },
    expect: [
      ["link-pr.mjs", ["c1", 4, "acme/main", 42, "abc123sha"]],
      ["reattach-ci.mjs", ["c1", "acme/main", 42, "abc123sha"]],
    ],
  },
  {
    name: "submitted + kind:respawn (fix) → push THEN reattach-ci (NEVER link-pr on respawn)",
    verdict: { status: "submitted", evidence: { repo: "acme/main", pr_number: 42, head: "newhead" } },
    ctx: { id: "c1", state: "dev", role: "developer", to: "test", gen: 4, kind: "respawn" },
    expect: [
      ["push.mjs", ["c1", 4, "acme/main", 42, "newhead"]],
      ["reattach-ci.mjs", ["c1", "acme/main", 42, "newhead"]],
    ],
  },
  {
    name: "submitted + kind:reclaim → treated as first-submission link-pr (reclaim == work)",
    verdict: { status: "submitted", evidence: { repo: "r", pr_number: 7, head: "h" } },
    ctx: { id: "c1", state: "dev", role: "developer", to: "test", gen: 9, kind: "reclaim" },
    expect: [
      ["link-pr.mjs", ["c1", 9, "r", 7, "h"]],
      ["reattach-ci.mjs", ["c1", "r", 7, "h"]],
    ],
  },
  {
    name: "analyst decomposed (2 children, one with depends_on) → create×2 then move epic",
    verdict: {
      status: "decomposed",
      to: "epic_integrating",
      children: [
        { title: "Story A" },
        { title: "Story B", depends_on: ["story-a-id"] },
      ],
    },
    ctx: { id: "epic-1", state: "epic_decompose", role: "analyst", to: "epic_integrating", gen: 2, type: "epic" },
    expect: [
      ["create.mjs", ["Story A", "--parent", "epic-1"]],
      ["create.mjs", ["Story B", "--parent", "epic-1", "--depends-on", "story-a-id"]],
      ["move.mjs", ["epic-1", 2, "epic_integrating", "analyst"]],
    ],
  },
  {
    name: "question → escalate (park for a human)",
    verdict: { status: "question", reason: "ambiguous spec section 3" },
    ctx: { id: "c1", state: "spec", role: "designer", to: "dev", gen: 1, kind: "work" },
    expect: [["escalate.mjs", ["c1", "ambiguous spec section 3"]]],
  },
  {
    name: "question with no reason → escalate with a generic reason",
    verdict: { status: "question" },
    ctx: { id: "c1", state: "spec", role: "designer", to: "dev", gen: 1, kind: "work" },
    expect: [["escalate.mjs", ["c1", "question"]]],
  },
  {
    name: "error verdict → no act posted (log + retry next pass)",
    verdict: { status: "error", reason: "tool failure" },
    ctx: { id: "c1", state: "dev", role: "developer", to: "test", gen: 2, kind: "work" },
    expect: [],
  },
  {
    name: "advisor advice → advice.mjs under the dispatched advisor role (NOT default security-advisor)",
    verdict: { status: "advice", head: "head1", reason: "tighten input validation" },
    ctx: { id: "c1", state: "test", role: "code-reviewer", to: "done", gen: 4, kind: "work" },
    expect: [["advice.mjs", ["c1", "head1", "tighten input validation", "--role", "code-reviewer"]]],
  },
  {
    name: "advisor clean → advice.mjs with NO reason arg (clean omits reason)",
    verdict: { status: "clean", head: "head2" },
    ctx: { id: "c1", state: "dev", role: "security-advisor", to: "test", gen: 4, kind: "work" },
    expect: [["advice.mjs", ["c1", "head2", "--role", "security-advisor"]]],
  },
  {
    name: "advisor veto → veto.mjs (always security-advisor identity; no --role flag)",
    verdict: { status: "veto", head: "head3", reason: "secrets in logs" },
    ctx: { id: "c1", state: "dev", role: "security-advisor", to: "test", gen: 4, kind: "work" },
    expect: [["veto.mjs", ["c1", "head3", "secrets in logs"]]],
  },
  {
    name: "advisor hold → hold.mjs (no --role flag)",
    verdict: { status: "hold", head: "head4", reason: "license review" },
    ctx: { id: "c1", state: "dev", role: "security-advisor", to: "test", gen: 4, kind: "work" },
    expect: [["hold.mjs", ["c1", "head4", "license review"]]],
  },
  {
    name: "advisor reject (no verdict.to) → conductor derives the backward edge, posts under advisor role",
    verdict: { status: "reject", reason: "blocking bug confirmed" },
    ctx: { id: "c1", state: "test", role: "code-reviewer", to: "done", gen: 6, kind: "work" },
    // machine fixture has exactly one test→dev REJECT edge → derivedTo = "dev"
    expect: [["reject.mjs", ["c1", 6, "dev", "code-reviewer"]]],
  },
];

for (const c of CASES) {
  test(`routeVerdict parity: ${c.name}`, async () => {
    const { acts } = await route({ verdict: c.verdict, ctx: c.ctx });
    assert.deepEqual(acts, c.expect, `acts must match SKILL.md routing exactly for: ${c.name}`);
  });
}

// ---- no-parse (null verdict) ----------------------------------------------------

test("routeVerdict: null verdict (no parseable block) → no act posted", async () => {
  const { acts } = await route({ verdict: null, ctx: { id: "c1", state: "dev", role: "developer", to: "test", gen: 2, kind: "work" } });
  assert.deepEqual(acts, [], "a no-parse verdict posts nothing (SKILL.md: log; retry next pass)");
});

// ---- worker reject with bounce-budget-exhausted 422 → escalate ------------------

test("routeVerdict: worker reject that 422s 'bounce budget exhausted' → escalate (do not re-loop)", async () => {
  const { acts } = await route({
    verdict: { status: "reject", to: "dev", reason: "fail" },
    ctx: { id: "c1", state: "test", role: "tester", to: "done", gen: 5, kind: "work" },
    overrides: {
      run: makeRun({
        "reject.mjs": { ok: false, status: 422, outcome: "gate_blocked", blocked_by: ["bounce_budget"], reason: "bounce budget exhausted" },
      }),
    },
  });
  assert.deepEqual(acts, [
    ["reject.mjs", ["c1", 5, "dev", "tester"]],
    // The reject was attempted (recorded), then escalated because the bounce budget was exhausted.
    ["escalate.mjs", ["c1", "bounce budget: test→dev"]],
  ]);
});

// ---- decomposed with ZERO children → escalate (mirrors reduce() 0-child rule) ----

test("routeVerdict: decomposed with zero-length children → escalate (treat as question)", async () => {
  const { acts } = await route({
    verdict: { status: "decomposed", to: "epic_integrating", children: [] },
    ctx: { id: "epic-1", state: "epic_decompose", role: "analyst", to: "epic_integrating", gen: 2, type: "epic" },
  });
  assert.deepEqual(acts, [["escalate.mjs", ["epic-1", "decomposed with no children"]]]);
});

// ---- decomposed: a CREATE failure mid-loop stops further CREATEs for this card ----

test("routeVerdict: decomposed — a non-committed CREATE stops the loop (no further CREATEs, no move)", async () => {
  const { acts } = await route({
    verdict: { status: "decomposed", to: "epic_integrating", children: [{ title: "A" }, { title: "B" }] },
    ctx: { id: "epic-1", state: "epic_decompose", role: "analyst", to: "epic_integrating", gen: 2, type: "epic" },
    overrides: {
      run: makeRun({
        "create.mjs": { ok: false, status: 500, outcome: "error", reason: "board 500" },
      }),
    },
  });
  // First CREATE attempted + failed → stop. Second CREATE never issued, MOVE never issued.
  assert.deepEqual(acts, [["create.mjs", ["A", "--parent", "epic-1"]]]);
});

// ---- advisor advice + spawn[] : fingerprint → dedup → create → note -------------

test("routeVerdict: advisor advice + spawn[] → advice once, then per entry fingerprint+create+note", async () => {
  const { acts } = await route({
    verdict: {
      status: "advice",
      head: "head1",
      reason: "minor nits",
      spawn: [
        { title: "Bug A", file: "src/a.ts", summary: "null deref in a()", note: "repro: call a(null)" },
        { title: "Bug B", file: "src/b.ts", summary: "race in b()", note: "repro: concurrent b()" },
      ],
    },
    ctx: { id: "c1", state: "test", role: "code-reviewer", to: "done", gen: 4, kind: "work", repo: "acme/main" },
    overrides: {
      run: makeRun({
        "fingerprint.mjs": (args) => ({ id: "bug-" + args[1] }), // deterministic mock id from the file arg
      }),
    },
  });
  assert.deepEqual(acts, [
    ["advice.mjs", ["c1", "head1", "minor nits", "--role", "code-reviewer"]],
    ["fingerprint.mjs", ["acme/main", "src/a.ts", "null deref in a()"]],
    ["create.mjs", ["Bug A", "--id", "bug-src/a.ts", "--type", "bug", "--state", "dev", "--parent", "c1", "--role", "orchestrator"]],
    ["note.mjs", ["bug-src/a.ts", "repro: call a(null)"]],
    ["fingerprint.mjs", ["acme/main", "src/b.ts", "race in b()"]],
    ["create.mjs", ["Bug B", "--id", "bug-src/b.ts", "--type", "bug", "--state", "dev", "--parent", "c1", "--role", "orchestrator"]],
    ["note.mjs", ["bug-src/b.ts", "repro: concurrent b()"]],
  ]);
});

test("routeVerdict: spawn entry with empty note → CREATE but NO note (skip blank NOTE)", async () => {
  const { acts } = await route({
    verdict: { status: "clean", head: "h", spawn: [{ title: "Bug", file: "f.ts", summary: "s" }] },
    ctx: { id: "c1", state: "test", role: "code-reviewer", to: "done", gen: 4, kind: "work", repo: "r" },
    overrides: { run: makeRun({ "fingerprint.mjs": () => ({ id: "bug-x" }) }) },
  });
  assert.deepEqual(acts, [
    ["advice.mjs", ["c1", "h", "--role", "code-reviewer"]], // clean → advice, no reason
    ["fingerprint.mjs", ["r", "f.ts", "s"]],
    ["create.mjs", ["Bug", "--id", "bug-x", "--type", "bug", "--state", "dev", "--parent", "c1", "--role", "orchestrator"]],
    // no note.mjs — blank note skipped
  ]);
});

test("routeVerdict: spawn dedup — existing card WITH notes → SKIP entirely (idempotent)", async () => {
  const { acts } = await route({
    verdict: { status: "advice", head: "h", spawn: [{ title: "Bug", file: "f.ts", summary: "s", note: "n" }] },
    ctx: { id: "c1", state: "test", role: "code-reviewer", to: "done", gen: 4, kind: "work", repo: "r" },
    overrides: {
      run: makeRun({ "fingerprint.mjs": () => ({ id: "bug-x" }) }),
      getCard: async (id) => (id === "bug-x" ? { id, notes: [{ text: "already filed" }] } : null),
    },
  });
  assert.deepEqual(acts, [
    ["advice.mjs", ["c1", "h", "--role", "code-reviewer"]],
    ["fingerprint.mjs", ["r", "f.ts", "s"]],
    // card exists with non-empty notes → fully filed → SKIP create + note
  ]);
});

test("routeVerdict: spawn dedup — existing card with EMPTY notes + a note to post → NOTE alone (no re-CREATE)", async () => {
  const { acts } = await route({
    verdict: { status: "advice", head: "h", spawn: [{ title: "Bug", file: "f.ts", summary: "s", note: "the repro" }] },
    ctx: { id: "c1", state: "test", role: "code-reviewer", to: "done", gen: 4, kind: "work", repo: "r" },
    overrides: {
      run: makeRun({ "fingerprint.mjs": () => ({ id: "bug-x" }) }),
      getCard: async (id) => (id === "bug-x" ? { id, notes: [] } : null), // exists, NOTE never landed
    },
  });
  assert.deepEqual(acts, [
    ["advice.mjs", ["c1", "h", "--role", "code-reviewer"]],
    ["fingerprint.mjs", ["r", "f.ts", "s"]],
    ["note.mjs", ["bug-x", "the repro"]], // retry the NOTE alone, no re-CREATE
  ]);
});

test("routeVerdict: spawn dedup — existing card, empty notes, NO note to post → SKIP (nothing to attach)", async () => {
  const { acts } = await route({
    verdict: { status: "clean", head: "h", spawn: [{ title: "Bug", file: "f.ts", summary: "s" }] }, // no note
    ctx: { id: "c1", state: "test", role: "code-reviewer", to: "done", gen: 4, kind: "work", repo: "r" },
    overrides: {
      run: makeRun({ "fingerprint.mjs": () => ({ id: "bug-x" }) }),
      getCard: async () => ({ id: "bug-x", notes: [] }), // exists, no note to post
    },
  });
  assert.deepEqual(acts, [
    ["advice.mjs", ["c1", "h", "--role", "code-reviewer"]],
    ["fingerprint.mjs", ["r", "f.ts", "s"]],
    // exists + nothing to attach → skip
  ]);
});

test("routeVerdict: spawn cap 20 — only the first 20 entries processed (rest deferred, not dropped silently)", async () => {
  const spawn = Array.from({ length: 25 }, (_, i) => ({ title: `Bug ${i}`, file: `f${i}.ts`, summary: `s${i}`, note: `n${i}` }));
  const { acts, raw } = await route({
    verdict: { status: "advice", head: "h", spawn },
    ctx: { id: "c1", state: "test", role: "code-reviewer", to: "done", gen: 4, kind: "work", repo: "r" },
    overrides: { run: makeRun({ "fingerprint.mjs": (a) => ({ id: "bug-" + a[1] }) }) },
  });
  // 1 advice + (20 × 3: fingerprint, create, note) = 61 calls; 5 entries deferred.
  const fingerprints = acts.filter(([s]) => s === "fingerprint.mjs");
  assert.equal(fingerprints.length, 20, "cap at 20 spawn entries (mirrors reduce() cap)");
  assert.equal(raw.spawnDeferred, 5, "the drop count is surfaced for logging");
});

test("routeVerdict: spawn — a CREATE failure stops further spawn entries for this card this pass", async () => {
  const { acts } = await route({
    verdict: { status: "advice", head: "h", spawn: [
      { title: "A", file: "fa", summary: "sa", note: "na" },
      { title: "B", file: "fb", summary: "sb", note: "nb" },
    ] },
    ctx: { id: "c1", state: "test", role: "code-reviewer", to: "done", gen: 4, kind: "work", repo: "r" },
    overrides: {
      run: makeRun({
        "fingerprint.mjs": (a) => ({ id: "bug-" + a[1] }),
        "create.mjs": { ok: false, status: 500, outcome: "error", reason: "boom" },
      }),
    },
  });
  // advice + fingerprint(A) + create(A, fails) → stop. No note(A), no fingerprint(B)/create(B).
  assert.deepEqual(acts, [
    ["advice.mjs", ["c1", "h", "--role", "code-reviewer"]],
    ["fingerprint.mjs", ["r", "fa", "sa"]],
    ["create.mjs", ["A", "--id", "bug-fa", "--type", "bug", "--state", "dev", "--parent", "c1", "--role", "orchestrator"]],
  ]);
});

test("routeVerdict: spawn — a NOTE failure stops further spawn entries for this card this pass", async () => {
  const { acts } = await route({
    verdict: { status: "advice", head: "h", spawn: [
      { title: "A", file: "fa", summary: "sa", note: "na" },
      { title: "B", file: "fb", summary: "sb", note: "nb" },
    ] },
    ctx: { id: "c1", state: "test", role: "code-reviewer", to: "done", gen: 4, kind: "work", repo: "r" },
    overrides: {
      run: makeRun({
        "fingerprint.mjs": (a) => ({ id: "bug-" + a[1] }),
        "note.mjs": { ok: false, status: 500, outcome: "error", reason: "note boom" },
      }),
    },
  });
  assert.deepEqual(acts, [
    ["advice.mjs", ["c1", "h", "--role", "code-reviewer"]],
    ["fingerprint.mjs", ["r", "fa", "sa"]],
    ["create.mjs", ["A", "--id", "bug-fa", "--type", "bug", "--state", "dev", "--parent", "c1", "--role", "orchestrator"]],
    ["note.mjs", ["bug-fa", "na"]], // attempted + failed → stop
  ]);
});

// ---- advisor reject: ambiguous backward edge (0 or >1) → escalate ---------------

test("rejectTargetOf: exactly one REJECT edge → its target", () => {
  const m = { transitions: [{ from: "test", type: "REJECT", to: "dev" }] };
  assert.equal(rejectTargetOf(m, "test"), "dev");
});

test("rejectTargetOf: zero REJECT edges → undefined (caller escalates, never guesses)", () => {
  const m = { transitions: [] };
  assert.equal(rejectTargetOf(m, "test"), undefined);
});

test("rejectTargetOf: more than one REJECT edge → undefined (ambiguous → escalate)", () => {
  const m = { transitions: [
    { from: "test", type: "REJECT", to: "dev" },
    { from: "test", type: "REJECT", to: "spec" },
  ] };
  assert.equal(rejectTargetOf(m, "test"), undefined);
});

test("rejectTargetOf: ignores REJECT edges from OTHER states + non-REJECT types", () => {
  const m = { transitions: [
    { from: "dev", type: "REJECT", to: "spec" }, // wrong from
    { from: "test", type: "MOVE", to: "done" }, // wrong type
    { from: "test", type: "REJECT", to: "dev" }, // the one
  ] };
  assert.equal(rejectTargetOf(m, "test"), "dev");
});

test("routeVerdict: advisor reject with NO derivable backward edge → escalate (never guess)", async () => {
  const { acts } = await route({
    verdict: { status: "reject", reason: "bug" },
    ctx: { id: "c1", state: "test", role: "code-reviewer", to: "done", gen: 6, kind: "work" },
    overrides: { machine: { transitions: [] } }, // no REJECT edge for test
  });
  assert.deepEqual(acts, [["escalate.mjs", ["c1", "reject edge ambiguous for state test"]]]);
});

// ---- THE async reshape: 422 blocked_by ⊇ advisor_clear on a MOVE ---------------

test("routeVerdict: MOVE 422 advisor_clear → fire-and-forget advisor dispatch, NO same-pass retry", async () => {
  // This is the async reshape of SKILL.md's same-pass inline advisor. The advisor is dispatched async; its
  // verdict reconciles NEXT pass; the MOVE is NOT retried this pass. advisor_clear retry happens via the
  // normal decide→dispatch cycle once the advice lands.
  const dispatched = [];
  const { acts, dispatches, advisorClear422 } = await route({
    verdict: { status: "advance" },
    ctx: { id: "c1", state: "test", role: "tester", to: "done", gen: 7, kind: "work" },
    overrides: {
      run: makeRun({
        "move.mjs": { ok: false, status: 422, outcome: "gate_blocked", blocked_by: ["advisor_clear"] },
      }),
      dispatch: (role, cardId, promptFile) => {
        dispatched.push({ role, cardId, promptFile });
        return "/v/advisor-1";
      },
      buildAdvisorPrompt: (ctx, role) => `/tmp/advisor-${ctx.id}-${role}.txt`,
    },
  });
  // 1) the MOVE was attempted (and 422'd) — recorded.
  assert.deepEqual(acts, [["move.mjs", ["c1", 7, "done", "tester"]]], "no other acts (no retry, no note)");
  // 2) advisor dispatched async, role derived from lifecycle.test.advisors[0].role (NOT hardcoded).
  assert.deepEqual(dispatches, [{ role: "code-reviewer", cardId: "c1", promptFile: "/tmp/advisor-c1-code-reviewer.txt" }]);
  assert.deepEqual(dispatched, [{ role: "code-reviewer", cardId: "c1", promptFile: "/tmp/advisor-c1-code-reviewer.txt" }]);
  // 3) flag set so the caller (reconcileVerdicts) can log / decide whether to consume.
  assert.equal(advisorClear422, true);
});

test("routeVerdict: MOVE 422 with a NON-advisor_clear blocked_by → ordinary failure path (no advisor dispatch)", async () => {
  // Only advisor_clear triggers the async advisor reshape; any other predicate is an ordinary gate block
  // (CLEAR_LEASE; decide re-derives next pass) — no dispatch.
  const { acts, dispatches, advisorClear422 } = await route({
    verdict: { status: "advance" },
    ctx: { id: "c1", state: "dev", role: "developer", to: "test", gen: 3, kind: "work" },
    overrides: {
      run: makeRun({
        "move.mjs": { ok: false, status: 422, outcome: "gate_blocked", blocked_by: ["ci_green"] },
      }),
    },
  });
  assert.deepEqual(acts, [["move.mjs", ["c1", 3, "test", "developer"]]]);
  assert.deepEqual(dispatches, [], "non-advisor_clear 422 does NOT dispatch an advisor");
  assert.equal(advisorClear422, false);
});

test("routeVerdict: MOVE 422 advisor_clear but state has NO configured advisor → no dispatch (inert)", async () => {
  // A stage with no advisor never produces advisor_clear in practice; if it somehow did, there is no role
  // to dispatch → log + no dispatch (don't guess a role).
  const { dispatches } = await route({
    verdict: { status: "advance" },
    ctx: { id: "c1", state: "spec", role: "designer", to: "dev", gen: 3, kind: "work" }, // spec has no advisors
    overrides: {
      run: makeRun({
        "move.mjs": { ok: false, status: 422, outcome: "gate_blocked", blocked_by: ["advisor_clear"] },
      }),
      lifecycle: { spec: {} }, // no advisors
    },
  });
  assert.deepEqual(dispatches, [], "no advisor configured → no async dispatch");
});

// ---- best-effort: routeVerdict never throws (one bad verdict doesn't abort the pass) ----

test("routeVerdict: an unexpected error in `run` is caught → surfaced, not thrown", async () => {
  // A crashing act script (or a thrown mock) must not abort routing. routeVerdict returns the acts it did
  // manage; the caller (reconcileVerdicts) wraps the whole per-card pass in try/catch too.
  const r = await route({
    verdict: { status: "advance" },
    ctx: { id: "c1", state: "spec", role: "designer", to: "dev", gen: 1, kind: "work" },
    overrides: {
      run: async () => { throw new Error("spawn EAGAIN"); },
    },
  });
  assert.ok(r.raw.error instanceof Error, "error surfaced on the result, not thrown");
});

// ---- GH #54: unhandled act failures must be surfaced as actFailed, not silently discarded ----

test("routeVerdict: advance MOVE that 422s (not advisor_clear) → actFailed set, not silent", async () => {
  const r = await route({
    verdict: { status: "advance" },
    ctx: { id: "c1", to: "done", role: "tester", state: "test", gen: "1" },
    overrides: { run: async (script) => (script === "move.mjs" ? { ok: false, status: 422, outcome: "bad_act", reason: "no edge" } : { ok: true }) },
  });
  assert.ok(r.actFailed, "actFailed must be set on an unhandled MOVE failure");
  assert.equal(r.actFailed.script, "move.mjs");
});

test("routeVerdict: advance MOVE with advisor_clear 422 → NOT actFailed (handled path)", async () => {
  const r = await route({
    verdict: { status: "advance" },
    ctx: { id: "c1", to: "done", role: "tester", state: "test", gen: "1" },
    overrides: { run: async (script) => (script === "move.mjs" ? { ok: false, outcome: "gate_blocked", blocked_by: ["advisor_clear"] } : { ok: true }) },
  });
  assert.equal(r.actFailed, null, "advisor_clear is a handled reshape, not an act failure");
});

test("routeVerdict: happy advance → NOT actFailed", async () => {
  const r = await route({
    verdict: { status: "advance", summary: "ok" },
    ctx: { id: "c1", to: "done", role: "tester", state: "test", gen: "1" },
    overrides: { run: async () => ({ ok: true }) },
  });
  assert.equal(r.actFailed, null);
});

test("routeVerdict: decomposed barrier MOVE fails after CREATEs → actFailed + escalate", async () => {
  const r = await route({
    verdict: { status: "decomposed", children: [{ title: "child A" }] },
    ctx: { id: "epic1", to: "epic_decompose", role: "analyst", state: "epic_decompose", gen: "1" },
    overrides: { run: async (script) => (script === "move.mjs" ? { ok: false, status: 422, reason: "no edge" } : { ok: true }) },
  });
  assert.ok(r.actFailed, "barrier MOVE failure must set actFailed");
  assert.equal(r.actFailed.script, "move.mjs");
  assert.ok(r.acts.some(([s]) => s === "escalate.mjs"), "half-advanced epic must escalate");
});
