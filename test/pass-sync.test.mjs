/*
 * pass-sync.test.mjs — pins applySyncAction's promote path (the V1 gap closed for the #28 cutover):
 * 422 branching (human_go / all_children_terminal / other) and the epic_done signal on an epic barrier.
 * `run` and `signalEpicDone` are injected — no board, no fs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applySyncAction } from "../skills/yarradev-run/scripts/pass.mjs";

/** Fake run: returns a canned result for a given script (keyed by the promote.mjs result we want to test). */
function fakeRun(promoteResult) {
  const calls = [];
  const run = async (script, args) => {
    calls.push({ script, args });
    if (script === "promote.mjs") return promoteResult;
    if (script === "claim.mjs") return { ok: true, gen: 7 };
    return { ok: true };
  };
  return { calls, run };
}

test("promote committed (no 422) → promote.mjs called, no epic signal for a non-epic", async () => {
  let signaled = null;
  const { calls, run } = fakeRun({ ok: true, status: 202, outcome: "committed" });
  const res = await applySyncAction({ kind: "promote", id: "c1", to: "staging" }, { run, card: { type: "story" }, signalEpicDone: (x) => (signaled = x) });
  assert.equal(res.outcome, "ok");
  assert.deepEqual(calls.map((c) => c.script), ["promote.mjs"]);
  assert.equal(signaled, null, "non-epic promote must not signal");
});

test("promote 422 human_go → noted 'awaiting human GO', no further acts", async () => {
  const { calls, run } = fakeRun({ ok: false, status: 422, outcome: "gate_blocked", blocked_by: ["human_go"] });
  const res = await applySyncAction({ kind: "promote", id: "c1", to: "prod" }, { run, card: { type: "story" }, signalEpicDone: () => {} });
  const notes = res.acts.filter((a) => a.note).map((a) => a.note);
  assert.ok(notes.some((n) => /awaiting human GO/.test(n)), notes.join("; "));
});

test("promote 422 all_children_terminal → noted 'child regressed'", async () => {
  const { run } = fakeRun({ ok: false, status: 422, outcome: "gate_blocked", blocked_by: ["all_children_terminal"] });
  const res = await applySyncAction({ kind: "promote", id: "e1", to: "epic_done", role: "analyst" }, { run, card: { type: "epic" }, signalEpicDone: () => {} });
  const notes = res.acts.filter((a) => a.note).map((a) => a.note);
  assert.ok(notes.some((n) => /child regressed/.test(n)), notes.join("; "));
  // not committed → no epic signal
  assert.ok(!notes.some((n) => /epic_done signal/.test(n)));
});

test("promote 422 other predicate → noted 'gate_blocked'", async () => {
  const { run } = fakeRun({ ok: false, status: 422, outcome: "gate_blocked", blocked_by: ["something_else"] });
  const res = await applySyncAction({ kind: "promote", id: "c1", to: "prod" }, { run, card: { type: "story" }, signalEpicDone: () => {} });
  const notes = res.acts.filter((a) => a.note).map((a) => a.note);
  assert.ok(notes.some((n) => /promote 422 gate_blocked: \[something_else\]/.test(n)), notes.join("; "));
});

test("epic barrier committed (epic → epic_done) → signalEpicDone fired with the summary", async () => {
  let signaled = null;
  const { run } = fakeRun({ ok: true, status: 202, outcome: "committed" });
  await applySyncAction(
    { kind: "promote", id: "epic-1", to: "epic_done", role: "analyst" },
    { run, card: { type: "epic", title: "SSO", children_total: 4 }, signalEpicDone: (x) => (signaled = x) },
  );
  assert.equal(signaled.epicId, "epic-1");
  assert.equal(signaled.title, "SSO");
  assert.equal(signaled.storyCount, 4);
});

test("epic barrier committed but to !== epic_done → no signal (e.g. a non-barrier epic promote)", async () => {
  let signaled = null;
  const { run } = fakeRun({ ok: true, status: 202, outcome: "committed" });
  await applySyncAction({ kind: "promote", id: "epic-1", to: "staging" }, { run, card: { type: "epic" }, signalEpicDone: (x) => (signaled = x) });
  assert.equal(signaled, null);
});

test("advance → claim + move + clear-lease (unchanged, regression guard)", async () => {
  const calls = [];
  const run = async (script, args) => { calls.push(script); if (script === "claim.mjs") return { ok: true, gen: 9 }; return { ok: true }; };
  const res = await applySyncAction({ kind: "advance", id: "c1", to: "test", role: "developer" }, { run });
  assert.deepEqual(calls, ["claim.mjs", "move.mjs", "clear-lease.mjs"]);
  assert.equal(res.outcome, "ok");
});

test("escalate → escalate.mjs with the reason (unchanged, regression guard)", async () => {
  const calls = [];
  const run = async (script, args) => { calls.push({ script, args }); return { ok: true }; };
  await applySyncAction({ kind: "escalate", id: "c1", reason: "CI stalled" }, { run });
  assert.equal(calls[0].script, "escalate.mjs");
  assert.deepEqual(calls[0].args, ["c1", "CI stalled"]);
});
