// test/runner-spawnpass.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnPass } from "../skills/yarradev-run/scripts/runner/daemon.mjs";

// Mirrors the fakeSpawn pattern in test/dispatch-stream.test.mjs: a child EventEmitter with
// .stdout/.stderr EventEmitters, plus a .kill() spy so timeout-kill behavior is observable.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = [];
  child.kill = (sig) => { child.killCalls.push(sig); };
  return child;
}

// pass.mjs's reconcileVerdicts emits one `{phase:"reconcile", verdictPath, cardId, outcome, ...}` line
// PER verdict entry (see pass.mjs's `results.push({..., outcome: ...})` and the CLI body's
// `process.stdout.write(JSON.stringify({phase:"reconcile", ...r}))`), where `outcome` is one of
// "routed"|"skipped"|"dispatch_error"|"no-parse"|"act_failed"|"error" — never a numeric `routed` field.
// spawnPass must count only the "routed" lines (successfully-routed verdicts).
test("spawnPass counts routed-outcome reconcile lines from JSON-line stdout, tolerating non-JSON lines and other outcomes", async () => {
  const child = fakeChild();
  const spawn = () => child;
  const p = spawnPass({ passPath: "/fake/pass.mjs", env: {}, spawn });
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from(JSON.stringify({ phase: "reconcile", verdictPath: "/v/1", cardId: "c1", outcome: "routed" }) + "\n"));
    child.stdout.emit("data", Buffer.from("not json, just a log line\n"));
    child.stdout.emit("data", Buffer.from(JSON.stringify({ phase: "reconcile", verdictPath: "/v/2", cardId: "c2", outcome: "skipped", reason: "stale verdict (card moved on)" }) + "\n"));
    child.stdout.emit("data", Buffer.from(JSON.stringify({ phase: "reconcile", verdictPath: "/v/3", cardId: "c3", outcome: "routed", advisorClear422: false }) + "\n"));
    child.stdout.emit("data", Buffer.from(JSON.stringify({ phase: "dispatch", dispatched: [], skipped: [] }) + "\n"));
    child.emit("close", 0, null);
  });
  const result = await p;
  assert.deepEqual(result, { ok: true, verdicts: 2, error: undefined });
});

test("spawnPass reports ok:false with the exit code on a nonzero exit", async () => {
  const child = fakeChild();
  const spawn = () => child;
  const p = spawnPass({ passPath: "/fake/pass.mjs", env: {}, spawn });
  queueMicrotask(() => { child.emit("close", 1, null); });
  const result = await p;
  assert.equal(result.ok, false);
  assert.equal(result.verdicts, 0);
  assert.equal(result.error, "exit 1");
});

// This is the regression test for the CONFIRMED bug: if spawn() fails to launch the process
// (EMFILE/ENOMEM/EACCES/ENOENT), Node's child_process only ever emits 'error' — never 'close'.
// Before the fix, spawnPass had no 'error' listener, so this promise hung forever (the
// timeoutMs guard doesn't rescue it either: it just calls .kill() on a process that never
// started, and 'close' still never fires). We use a short real timeoutMs as a backstop: if the
// error-handler fix regresses, this test fails/times out rather than hanging silently or
// passing vacuously.
test("spawnPass resolves (does not hang) when spawn() itself errors, e.g. ENOMEM/EMFILE", async () => {
  const child = fakeChild();
  const spawn = () => child;
  const p = spawnPass({ passPath: "/fake/pass.mjs", env: {}, timeoutMs: 200, spawn });
  queueMicrotask(() => {
    child.emit("error", Object.assign(new Error("spawn EMFILE"), { code: "EMFILE" }));
    // Deliberately never emit 'close' — this is the real-world failure mode.
  });
  const result = await p;
  assert.equal(result.ok, false);
  assert.equal(result.verdicts, 0);
  assert.match(result.error, /EMFILE/);
});

// Timeout-kill path: child never emits 'close' or 'error' at all (e.g. hung/runaway pass).
// With a short real timeoutMs, spawnPass's own timer should fire, call child.kill(), and
// resolve — but since our fake child never emits 'close' in response to kill() (no real OS
// process behind it), we can only assert the kill() call happened, not the final resolution,
// without waiting the full timeout again. So instead we simulate the realistic sequence: the
// timer fires -> kill() is called -> and (as real Node would after SIGKILL reaps the process)
// 'close' arrives after that. This keeps the assertion non-flaky (no reliance on wall-clock
// races) while still exercising the timeout branch's kill() call and its ok:false/"pass
// timeout" resolution.
test("spawnPass times out, calls kill(), and resolves ok:false with a timeout error", async () => {
  const child = fakeChild();
  const spawn = () => child;
  const p = spawnPass({ passPath: "/fake/pass.mjs", env: {}, timeoutMs: 20, spawn });
  // Once kill() is observed (i.e. the real timer fired), simulate the OS reaping the killed
  // process and emitting 'close' with a null exit code / SIGKILL signal.
  const waitForKill = async () => {
    while (child.killCalls.length === 0) await new Promise((r) => setTimeout(r, 5));
    child.emit("close", null, "SIGKILL");
  };
  waitForKill();
  const result = await p;
  assert.deepEqual(child.killCalls, ["SIGKILL"]);
  assert.equal(result.ok, false);
  assert.equal(result.error, "pass timeout");
});
