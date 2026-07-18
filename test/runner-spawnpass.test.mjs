// test/runner-spawnpass.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnPass, redactSecrets } from "../skills/yarradev-run/scripts/runner/daemon.mjs";

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
  // spawnPass stamps `events` with Date.now() at close time (it's runtime code, not a pure
  // helper), so we can't deep-equal the whole resolve object against a literal. Assert
  // ok/verdicts/error directly, then assert the events' shape with `at` stripped (and
  // separately that every `at` is a real timestamp).
  assert.equal(result.ok, true);
  assert.equal(result.verdicts, 2);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.events.map(({ at, ...rest }) => rest), [
    { cardId: "c1", role: null, state: null, to: null, event: "reconcile", outcome: "routed", detail: null },
    { cardId: "c2", role: null, state: null, to: null, event: "reconcile", outcome: "skipped", detail: null },
    { cardId: "c3", role: null, state: null, to: null, event: "reconcile", outcome: "routed", detail: null },
  ]);
  assert.ok(result.events.every((e) => typeof e.at === "number"));
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

// ---- #91: pass failures must carry a reason ------------------------------------------------------
// A board sat wedged for hours on 2026-07-18 while every dispatched subagent crashed on
// `API Error: 429 [1310][Weekly/Monthly Limit Exhausted]`. The runner reported
// { paused:false, breaker:"CLOSED", lastTick:{ok:true} } throughout — the "loop looks healthy and is
// doing nothing" class is invisible from status, which is the first (and often only) thing anyone
// checks. stderr held the reason and was discarded on the floor.

test("#91: spawnPass attaches captured stderr to the error on a nonzero exit", async () => {
  const child = fakeChild();
  const p = spawnPass({ passPath: "/fake/pass.mjs", env: {}, spawn: () => child });
  queueMicrotask(() => {
    child.stderr.emit("data", Buffer.from("API Error: 429 [1310][Weekly/Monthly Limit Exhausted]\n"));
    child.emit("close", 1, null);
  });
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.error, /^exit 1: /, "keeps the exit code prefix");
  assert.match(r.error, /Weekly\/Monthly Limit Exhausted/, "the actual reason must reach the caller");
});

test("#91: spawnPass still drains stderr and emits NO error on a clean exit", async () => {
  // The drain is load-bearing — a chatty pass must not fill the pipe buffer and block the child.
  // Capturing must not change that, and a successful pass stays error-free however noisy it was.
  const child = fakeChild();
  const p = spawnPass({ passPath: "/fake/pass.mjs", env: {}, spawn: () => child });
  queueMicrotask(() => {
    child.stderr.emit("data", Buffer.from("[pass] chatty but harmless\n"));
    child.emit("close", 0, null);
  });
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.error, undefined, "a clean exit carries no error even with stderr output");
});

test("#91: spawnPass REDACTS secrets from captured stderr", async () => {
  // stderr can carry an Authorization header, a token in a URL, or an env dump. lastTick.error
  // surfaces through the runner MCP `status` tool into agent transcripts and logs, so the capture
  // must scrub before it stores. Best-effort by construction — bounded patterns, not a guarantee.
  const child = fakeChild();
  const p = spawnPass({ passPath: "/fake/pass.mjs", env: {}, spawn: () => child });
  queueMicrotask(() => {
    child.stderr.emit("data", Buffer.from(
      "authorization: Bearer sk-ant-oat01-SECRETVALUE\n" +
      "YDB_TOKEN_DEVELOPER=tok.SECRETVALUE\n" +
      "gh token ghp_SECRETVALUEsecretvalue123456\n",
    ));
    child.emit("close", 1, null);
  });
  const r = await p;
  assert.ok(!r.error.includes("SECRETVALUE"), `secret leaked into the error: ${r.error}`);
  assert.match(r.error, /redacted/, "redaction is visible, not silent truncation");
});

test("#91: spawnPass bounds the captured stderr so status can't bloat", async () => {
  const child = fakeChild();
  const p = spawnPass({ passPath: "/fake/pass.mjs", env: {}, spawn: () => child });
  queueMicrotask(() => {
    for (let i = 0; i < 200; i++) child.stderr.emit("data", Buffer.from("x".repeat(500) + "\n"));
    child.emit("close", 1, null);
  });
  const r = await p;
  assert.ok(r.error.length <= 2100, `error must stay bounded, got ${r.error.length} chars`);
});

test("#91: a pass timeout keeps its 'pass timeout' error (not replaced by stderr)", async () => {
  const child = fakeChild();
  const p = spawnPass({ passPath: "/fake/pass.mjs", env: {}, timeoutMs: 10, spawn: () => child });
  child.stderr.emit("data", Buffer.from("some noise\n"));
  setTimeout(() => child.emit("close", null, "SIGKILL"), 40);
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.error, /pass timeout/);
});

test("#91: redactSecrets scrubs the known secret shapes and leaves ordinary text intact", () => {
  const r = redactSecrets(
    "authorization: Bearer sk-ant-oat01-AAA\n" +
    "YDB_TOKEN_DEVELOPER=tok.BBB\n" +
    "ANTHROPIC_API_KEY: sk-ant-CCC\n" +
    "ghp_DDDDDDDDDDDDDDDD ghs_EEEEEEEEEEEEEEEE\n" +
    "https://board.test/acts?token=FFF&x=1\n" +
    "API Error: 429 [1310][Weekly/Monthly Limit Exhausted]\n",
  );
  for (const secret of ["AAA", "BBB", "CCC", "DDDDDDDDDDDDDDDD", "EEEEEEEEEEEEEEEE", "FFF"]) {
    assert.ok(!r.includes(secret), `leaked ${secret}: ${r}`);
  }
  assert.match(r, /Weekly\/Monthly Limit Exhausted/, "the diagnostic content must survive redaction");
  assert.match(r, /x=1/, "non-secret query params are untouched");
});
