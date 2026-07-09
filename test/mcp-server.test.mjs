// test/mcp-server.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, handleMessage } from "../skills/yarradev-run/scripts/mcp/server.mjs";

const NAMES = ["status","inflight","recent","logs","explain","attention","pause","resume","tick","retry"];

test("catalog is exactly the 10 runner tools — no human-gate tools", () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), [...NAMES].sort());
  for (const forbidden of ["human_go","humanGo","clear_veto","veto","hold","move","create"]) {
    assert.ok(!TOOLS.some((t) => t.name === forbidden), `${forbidden} must be absent (A1)`);
  }
  for (const t of TOOLS) { assert.equal(typeof t.description, "string"); assert.equal(t.inputSchema.type, "object"); }
});

test("initialize returns tools capability + serverInfo", async () => {
  const r = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { call: async () => {} });
  assert.equal(r.id, 1);
  assert.ok(r.result.capabilities.tools);
  assert.equal(typeof r.result.serverInfo.name, "string");
});

test("tools/list returns the catalog", async () => {
  const r = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { call: async () => {} });
  assert.equal(r.result.tools.length, 10);
});

test("tools/call invokes call() and wraps text content", async () => {
  const r = await handleMessage(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "status", arguments: {} } },
    { call: async (name, args) => ({ ok: true, name, args }) });
  assert.equal(r.result.content[0].type, "text");
  assert.deepEqual(JSON.parse(r.result.content[0].text), { ok: true, name: "status", args: {} });
});

test("tools/call surfaces errors as isError, not a thrown response", async () => {
  const r = await handleMessage(
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "logs", arguments: {} } },
    { call: async () => { throw new Error("runner unreachable"); } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /runner unreachable/);
});

test("a notification (no id) yields no response", async () => {
  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, { call: async () => {} }), null);
});
