// test/runner-daemon.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDaemon } from "../skills/yarradev-run/scripts/runner/daemon.mjs";

test("single-flight: overlapping requestTick coalesces to one extra pass", async () => {
  let running = 0, maxConcurrent = 0, calls = 0;
  const runPass = async () => {
    running++; maxConcurrent = Math.max(maxConcurrent, running); calls++;
    await new Promise((r) => setImmediate(r));
    running--; return { ok: true };
  };
  const d = createDaemon({ runPass, intervalMs: 1e9, now: () => 0 });
  d.requestTick(); d.requestTick(); d.requestTick(); // 3 requests during one in-flight pass
  await d._drain();
  assert.equal(maxConcurrent, 1, "never overlaps");
  assert.equal(calls, 2, "one running + one coalesced dirty re-run");
});

test("pause blocks ticks", async () => {
  let calls = 0;
  const d = createDaemon({ runPass: async () => { calls++; return { ok: true }; }, intervalMs: 1e9, now: () => 0 });
  d.pause(); d.requestTick(); await d._drain();
  assert.equal(calls, 0);
  d.resume(); d.requestTick(); await d._drain();
  assert.equal(calls, 1);
});
