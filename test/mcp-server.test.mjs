// test/mcp-server.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TOOLS, handleMessage } from "../skills/yarradev-run/scripts/mcp/server.mjs";
import { route, makeCall } from "../skills/yarradev-run/scripts/mcp/proxy.mjs";

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

test("route maps reads to GET and controls to POST with params", () => {
  assert.deepEqual(route("status", {}), { method: "GET", path: "/status" });
  assert.deepEqual(route("logs", { id: "c1" }), { method: "GET", path: "/logs?id=c1" });
  assert.deepEqual(route("explain", { card: "c1" }), { method: "GET", path: "/explain?card=c1" });
  assert.deepEqual(route("pause", {}), { method: "POST", path: "/pause" });
  assert.deepEqual(route("retry", { card: "c1" }), { method: "POST", path: "/retry?card=c1" });
});

// #69.3: logs is unified on `card` (matching explain/retry) while still accepting the legacy `id` alias.
test("logs accepts card (unified) and id (legacy alias), both → ?id=", () => {
  assert.equal(TOOLS.find((t) => t.name === "logs").inputSchema.properties.card.type, "string");
  assert.deepEqual(route("logs", { card: "c1" }), { method: "GET", path: "/logs?id=c1" });
  assert.deepEqual(route("logs", { id: "c1" }), { method: "GET", path: "/logs?id=c1" });
  assert.deepEqual(route("logs", { card: "cNew", id: "cOld" }), { method: "GET", path: "/logs?id=cNew" }); // card wins
});

test("makeCall fetches the mapped route and returns JSON", async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push([url, opts?.method ?? "GET"]); return { ok: true, json: async () => ({ url, method: opts?.method ?? "GET" }) }; };
  const call = await makeCall({ port: 4599, fetchImpl });
  const r = await call("retry", { card: "c9" });
  assert.deepEqual(seen, [["http://127.0.0.1:4599/retry?card=c9", "POST"]]);
  assert.equal(r.method, "POST");
});

test("makeCall throws a clear error when the runner is unreachable", async () => {
  const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
  const call = await makeCall({ port: 4599, fetchImpl });
  await assert.rejects(call("status", {}), /runner not reachable on 127\.0\.0\.1:4599/);
});

test("plugin.json declares the runner MCP stdio server from the plugin root", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const pj = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  const s = pj.mcpServers?.["yarradev-runner"];
  assert.ok(s, "yarradev-runner MCP server must be declared");
  assert.equal(s.command, "node");
  assert.ok(s.args.some((a) => a.includes("${CLAUDE_PLUGIN_ROOT}") && a.endsWith("mcp/server.mjs")));
});
