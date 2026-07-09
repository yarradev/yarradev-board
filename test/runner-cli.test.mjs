import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildActions, buildProvider, clientUrl, ensureManifestFile, GET, COMMANDS } from "../bin/yarradev.mjs";

test("buildActions.pause pauses the daemon", () => {
  let paused = false;
  const daemon = { pause: () => { paused = true; }, resume() {}, requestTick() {} };
  const actions = buildActions({ daemon });
  assert.deepEqual(actions.pause(), { ok: true, paused: true });
  assert.equal(paused, true);
});

test("clientUrl maps subcommands to control-plane routes", () => {
  assert.equal(clientUrl("status", 4599), "http://127.0.0.1:4599/status");
  assert.equal(clientUrl("pause", 4599), "http://127.0.0.1:4599/pause");
});

// #72.1: the read routes the control plane serves as GET must be in the GET set (only status/logs were).
test("GET set covers every read route the control plane serves", () => {
  for (const r of ["status", "logs", "inflight", "recent", "attention", "explain", "cost"]) {
    assert.ok(GET.has(r), `${r} must be a GET route`);
  }
  for (const w of ["pause", "resume", "tick", "retry", "stop"]) {
    assert.ok(!GET.has(w), `${w} must not be a GET route`);
    assert.ok(COMMANDS.has(w), `${w} must be a known command`);
  }
});

// #72.2: logs / explain / retry must forward the card id as the query param each route expects.
test("clientUrl forwards a card id as the route's expected query param", () => {
  assert.equal(clientUrl("logs", 4599, "c1"), "http://127.0.0.1:4599/logs?id=c1");
  assert.equal(clientUrl("explain", 4599, "c1"), "http://127.0.0.1:4599/explain?card=c1");
  assert.equal(clientUrl("retry", 4599, "c1"), "http://127.0.0.1:4599/retry?card=c1");
  // routes that take no id ignore a stray arg
  assert.equal(clientUrl("status", 4599, "c1"), "http://127.0.0.1:4599/status");
  // absent/empty arg → no query string
  assert.equal(clientUrl("logs", 4599), "http://127.0.0.1:4599/logs");
  assert.equal(clientUrl("logs", 4599, ""), "http://127.0.0.1:4599/logs");
});

// Fix 6: stop() must pause the daemon FIRST, before tearing down sources — otherwise an in-flight
// loop with dirty=true (a tick already queued while the current pass runs) fires one more
// coalesced runPass after stop() has closed the server/sources.
test("buildActions.stop pauses the daemon (before stopping sources / closing the server)", () => {
  let paused = false;
  let stoppedSourcesCalled = false;
  let serverClosed = false;
  const daemon = { pause: () => { paused = true; }, resume() {}, requestTick() {} };
  const stopSources = () => { stoppedSourcesCalled = true; };
  const server = { close: () => { serverClosed = true; } };
  const actions = buildActions({ daemon, stopSources, getServer: () => server });
  const result = actions.stop();
  assert.deepEqual(result, { ok: true, stopped: true });
  assert.equal(paused, true, "stop() must call daemon.pause()");
  assert.equal(stoppedSourcesCalled, true);
  assert.equal(serverClosed, true);
});

// Fix 2: on a fresh machine the manifest file doesn't exist yet, so fs.watch(manifestFile) throws
// synchronously and startSources() silently falls back to interval-only polling forever (the
// "fire early when a verdict lands" feature never activates). ensureManifestFile() must create the
// state dir + touch an empty manifest file so fs.watch() can attach.
test("ensureManifestFile creates the state dir and touches an empty manifest file when absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "yd-ensure-manifest-"));
  const stateDir = join(dir, "state", "yarradev"); // nested — doesn't exist yet, not even the parent
  const env = { YARRADEV_STATE_DIR: stateDir };
  try {
    const mp = ensureManifestFile(env);
    assert.equal(mp, join(stateDir, "dispatch-manifest.jsonl"));
    assert.equal(existsSync(mp), true);
    assert.equal(readFileSync(mp, "utf8"), "");
    // fs.watch() must now succeed on this path (the actual regression being fixed).
    const w = watch(mp);
    w.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureManifestFile does not clobber an existing non-empty manifest file", () => {
  const dir = mkdtempSync(join(tmpdir(), "yd-ensure-manifest-existing-"));
  const env = { YARRADEV_STATE_DIR: dir };
  const mp = join(dir, "dispatch-manifest.jsonl");
  writeFileSync(mp, '{"status":"pending"}\n');
  try {
    ensureManifestFile(env);
    assert.equal(readFileSync(mp, "utf8"), '{"status":"pending"}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildActions.retry clears the lease via the client then ticks", async () => {
  let ticked = 0;
  const daemon = { requestTick: () => { ticked++; } };
  const client = { calls: [], async getEnriched() { return { current_gen: 4 }; }, async clearLease(id, gen) { this.calls.push([id, gen]); } };
  const actions = buildActions({ daemon, client });
  const params = new URLSearchParams({ card: "c1" });
  assert.deepEqual(await actions.retry(params), { ok: true, outcome: null, cardId: "c1", clearedGen: 4 });
  assert.deepEqual(client.calls, [["c1", 4]]);
  assert.equal(ticked, 1);
});

test("buildProvider.status reflects the real breaker file", async () => {
  const daemon = { isPaused: () => false, lastTick: () => ({ at: 1000, ok: true }), passRunning: () => false };
  const provider = buildProvider({ daemon, config: { pace: { minLoopIntervalS: 300 } }, env: { YARRADEV_STATE_DIR: "/nonexistent-state" }, client: {} });
  const s = await provider.status();
  assert.equal(s.breaker, "CLOSED"); // absent file → CLOSED
  assert.equal(typeof s.nextTickInS, "number");
});
