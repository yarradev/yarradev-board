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
