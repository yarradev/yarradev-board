import { test } from "node:test";
import assert from "node:assert/strict";
import { createControlPlane } from "../skills/yarradev-run/scripts/runner/control-plane.mjs";

function listen(s) { return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port))); }

test("async provider resolves through the route", async () => {
  const provider = { status: async () => ({ paused: false, breaker: "OPEN" }) };
  const server = createControlPlane({ provider, actions: {} });
  const port = await listen(server);
  const r = await fetch(`http://127.0.0.1:${port}/status`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { paused: false, breaker: "OPEN" });
  server.close();
});

test("a rejected async provider becomes a 500, not an unhandled rejection", async () => {
  const provider = { status: async () => { throw new Error("boom"); } };
  const server = createControlPlane({ provider, actions: {} });
  const port = await listen(server);
  const r = await fetch(`http://127.0.0.1:${port}/status`);
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /boom/);
  server.close();
});

test("async POST action resolves and 500s on reject", async () => {
  const server = createControlPlane({ provider: {}, actions: { pause: async () => ({ ok: true }), tick: async () => { throw new Error("nope"); } } });
  const port = await listen(server);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/pause`, { method: "POST" })).json(), { ok: true });
  assert.equal((await fetch(`http://127.0.0.1:${port}/tick`, { method: "POST" })).status, 500);
  server.close();
});
