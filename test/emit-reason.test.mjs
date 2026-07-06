/*
 * emit-reason.test.mjs — pins GH #17: emit() surfaces the board's diagnostic (reason/error) so 403 and
 * non-gate 422 rejections aren't opaque. Reads BOTH keys (toAppendResult normalizes to `reason` on the
 * synthesized path; the outcome-present path returns the board body verbatim where the board's own
 * convention is `error`), and omits the key entirely when no reason is present.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../skills/yarradev-run/scripts/plugin-io.mjs";

/** Capture emit()'s single stdout JSON line by stubbing process.stdout.write. */
function captureEmit(result, extra = {}) {
  let captured = "";
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured += chunk.toString();
    return true;
  };
  let code;
  try {
    code = emit(result, extra);
  } finally {
    process.stdout.write = real;
  }
  return { code, line: captured.trim() ? JSON.parse(captured.trim()) : null };
}

test("emit: committed with no reason → ok:true, no reason key", () => {
  const { code, line } = captureEmit({ outcome: "committed", status: 202 });
  assert.equal(code, 0);
  assert.equal(line.ok, true);
  assert.equal("reason" in line, false, "no reason key when absent");
});

test("emit: 403 unauthorized surfaces board `reason` (the caps-missing CLAIM case)", () => {
  const { code, line } = captureEmit({
    outcome: "unauthorized",
    status: 403,
    reason: "no capability for CLAIM (kind=agent, roles=[orchestrator])",
  });
  assert.equal(code, 1);
  assert.equal(line.ok, false);
  assert.equal(line.status, 403);
  assert.equal(line.reason, "no capability for CLAIM (kind=agent, roles=[orchestrator])");
});

test("emit: outcome-present path surfaces board `error` key", () => {
  // When the board returns a body WITH an outcome string, toAppendResult returns it verbatim; the board's
  // own convention there is `error`. emit() must still surface it (read either key).
  const { line } = captureEmit({ outcome: "bad_act", status: 422, error: "to state not in machine" });
  assert.equal(line.reason, "to state not in machine");
});

test("emit: prefers `reason` when both reason and error present", () => {
  const { line } = captureEmit({ outcome: "fenced", status: 409, reason: "stale gen", error: "ignored" });
  assert.equal(line.reason, "stale gen");
});

test("emit: extra fields (gen, blocked_by) still pass through alongside reason", () => {
  const { line } = captureEmit(
    { outcome: "gate_blocked", status: 422, blocked_by: ["advisor_clear"], reason: "advisor not cleared" },
    { gen: 7, blocked_by: ["advisor_clear"] },
  );
  assert.equal(line.gen, 7);
  assert.deepEqual(line.blocked_by, ["advisor_clear"]);
  assert.equal(line.reason, "advisor not cleared");
});
