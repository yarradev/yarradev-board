/*
 * reattach-ci.test.mjs — pins GH #21 client-side recovery. All board/gh deps are injected (no live board,
 * no gh), exercising the four decision branches of runReattachCi + the pure hasCompletedCheck helper.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runReattachCi, hasCompletedCheck } from "../skills/yarradev-run/scripts/reattach-ci.mjs";

function deps({ card, checks, runId }) {
  const calls = { ghJson: [], ghRun: [] };
  return {
    calls,
    getCard: async () => card,
    ghJson: (args, jq) => {
      calls.ghJson.push(args.join(" "));
      if (args[0] === "pr") return checks; // `gh pr checks …`
      if (args[0] === "run") return jq ? runId : [{ databaseId: runId }]; // `gh run list …`
      return null;
    },
    ghRun: (args) => {
      calls.ghRun.push(args.join(" "));
    },
  };
}

test("hasCompletedCheck: true for pass/fail buckets, false for pending/empty", () => {
  assert.equal(hasCompletedCheck([{ bucket: "pass" }, { bucket: "pending" }]), true);
  assert.equal(hasCompletedCheck([{ bucket: "fail" }]), true);
  assert.equal(hasCompletedCheck([{ bucket: "pending" }]), false);
  assert.equal(hasCompletedCheck([]), false);
  assert.equal(hasCompletedCheck(null), false);
  assert.equal(hasCompletedCheck(undefined), false);
});

test("noop when CI already landed on the board (ci_rollup != absent) — no rerun", async () => {
  const d = deps({ card: { ci_rollup: "success" }, checks: [{ bucket: "pass" }], runId: "99" });
  const res = await runReattachCi(d, { id: "c1", repo: "o/r", pr: "5", head: "abc" });
  assert.equal(res.action, "noop");
  assert.equal(res.reason, "ci_already_landed");
  assert.equal(d.calls.ghRun.length, 0, "must not re-trigger when CI already landed");
});

test("noop when GitHub checks are still pending — webhook will fire on completion against the pr_link", async () => {
  const d = deps({ card: { ci_rollup: "absent" }, checks: [{ bucket: "pending" }], runId: "99" });
  const res = await runReattachCi(d, { id: "c1", repo: "o/r", pr: "5", head: "abc" });
  assert.equal(res.action, "noop");
  assert.equal(res.reason, "ci_not_completed_yet");
  assert.equal(d.calls.ghRun.length, 0);
});

test("noop when checks completed but no workflow run found for the head", async () => {
  const d = deps({ card: { ci_rollup: "absent" }, checks: [{ bucket: "pass" }], runId: null });
  const res = await runReattachCi(d, { id: "c1", repo: "o/r", pr: "5", head: "abc" });
  assert.equal(res.action, "noop");
  assert.equal(res.reason, "no_workflow_run_for_head");
  assert.equal(d.calls.ghRun.length, 0);
});

test("re-triggered when checks completed + board absent (the stranded race) — reruns the head's run", async () => {
  const d = deps({ card: { ci_rollup: "absent" }, checks: [{ bucket: "pass" }, { bucket: "fail" }], runId: "4242" });
  const res = await runReattachCi(d, { id: "c1", repo: "o/r", pr: "5", head: "deadbeef" });
  assert.equal(res.action, "retriggered");
  assert.equal(res.runId, "4242");
  assert.equal(d.calls.ghRun.length, 1);
  assert.match(d.calls.ghRun[0], /run rerun 4242 --repo o\/r/);
  // run list must filter by the EXACT head (the pr_link correlation key), not the branch.
  assert.match(d.calls.ghJson.find((c) => c.startsWith("run list")), /--commit deadbeef/);
});

test("treats missing ci_rollup as absent (recovers when the field is unset)", async () => {
  const d = deps({ card: {}, checks: [{ bucket: "fail" }], runId: "7" });
  const res = await runReattachCi(d, { id: "c1", repo: "o/r", pr: "5", head: "abc" });
  assert.equal(res.action, "retriggered");
});
