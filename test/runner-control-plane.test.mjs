import { test } from "node:test";
import assert from "node:assert/strict";
import { createControlPlane } from "../skills/yarradev-run/scripts/runner/control-plane.mjs";

function listen(server) { return new Promise((res) => server.listen(0, "127.0.0.1", () => res(server.address().port))); }

test("GET /status returns provider status as JSON", async () => {
  const provider = { status: () => ({ paused: false, breaker: "CLOSED" }) };
  const server = createControlPlane({ provider, actions: {} });
  const port = await listen(server);
  const r = await fetch(`http://127.0.0.1:${port}/status`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { paused: false, breaker: "CLOSED" });
  server.close();
});

test("GET / serves the monitor page", async () => {
  const server = createControlPlane({ provider: {}, actions: {} });
  const port = await listen(server);
  const r = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/html/);
  server.close();
});

test("POST /pause invokes the action", async () => {
  let paused = false;
  const server = createControlPlane({ provider: {}, actions: { pause: () => { paused = true; return { ok: true }; } } });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/pause`, { method: "POST" });
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(paused, true);
  server.close();
});

test("POST /resume, /tick invoke their actions; /retry receives the card query param", async () => {
  const calls = [];
  const server = createControlPlane({
    provider: {},
    actions: {
      resume: () => { calls.push("resume"); return { ok: true }; },
      tick: () => { calls.push("tick"); return { ok: true }; },
      retry: (params) => { calls.push(`retry:${params.get("card")}`); return { ok: true, card: params.get("card") }; },
    },
  });
  const port = await listen(server);

  const rResume = await fetch(`http://127.0.0.1:${port}/resume`, { method: "POST" });
  assert.deepEqual(await rResume.json(), { ok: true });

  const rTick = await fetch(`http://127.0.0.1:${port}/tick`, { method: "POST" });
  assert.deepEqual(await rTick.json(), { ok: true });

  const rRetry = await fetch(`http://127.0.0.1:${port}/retry?card=c-42`, { method: "POST" });
  assert.deepEqual(await rRetry.json(), { ok: true, card: "c-42" });

  assert.deepEqual(calls, ["resume", "tick", "retry:c-42"]);
  server.close();
});

test("POST to an unknown action returns 404", async () => {
  const server = createControlPlane({ provider: {}, actions: { pause: () => ({ ok: true }) } });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/no-such-action`, { method: "POST" });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not found" });
  server.close();
});
