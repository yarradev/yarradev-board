// test/runner-daemon.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDaemon, startSources } from "../skills/yarradev-run/scripts/runner/daemon.mjs";
import { EventEmitter } from "node:events";

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

test("startSources debounces manifest events into one tick", async () => {
  let ticks = 0;
  const daemon = { requestTick: () => { ticks++; } };
  const watcher = new EventEmitter();
  const fakeWatch = () => watcher;
  const stop = startSources(daemon, { manifestFile: "/m", intervalMs: 1e9, debounceMs: 10, watch: fakeWatch, setInterval: () => 0 });
  watcher.emit("change"); watcher.emit("change"); watcher.emit("change");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ticks, 1);
  stop();
});

test("createDaemon folds pass events into an activity map exposed via getActivity()", async () => {
  const events = [{ cardId: "c1", event: "reconcile", outcome: "routed", detail: "dev→test", at: 1 }];
  const daemon = createDaemon({ runPass: async () => ({ ok: true, verdicts: 1, events }), intervalMs: 1000, now: () => 5 });
  await daemon.requestTick();
  await daemon._drain();
  assert.equal(daemon.getActivity().get("c1").detail, "dev→test");
});
