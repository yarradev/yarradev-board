/*
 * coherence-wiring.test.mjs — fail-closed CI test for list-ready.mjs's startup coherence gate
 * (Phase 2a Task 6). This is the top residual runtime risk from Phase 1: assertLifecycleCoherent was
 * only ever manually smoked; nothing pinned that list-ready ACTUALLY refuses to route against a board
 * whose GET /config machine disagrees with the plugin's board.json lifecycle.
 *
 * Hermetic (no real network): a local node:http stub on 127.0.0.1:0 serves an INCOHERENT machine at
 * GET /config (all 7 states but the dev->test edge missing → assertLifecycleCoherent throws). We spawn
 * the real list-ready.mjs against it and assert the fail-closed contract:
 *   - non-zero exit,
 *   - NO routing output on stdout,
 *   - a "refusing to route" diagnostic on stderr,
 *   - and that it bailed BEFORE ever listing cards (GET /cards was never requested).
 *
 * The stub's /cards + /enriched routes return a genuinely-routable backlog card, so if the gate were
 * bypassed list-ready WOULD emit a `work` line — which makes the empty-stdout assertion load-bearing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIST_READY = join(HERE, "..", "skills", "yarradev-run", "scripts", "list-ready.mjs");

// All 7 shipped states, but the dev->test forward edge is intentionally omitted → the plugin's
// board.example.json lifecycle (which HAS dev->test) is incoherent with this machine.
const INCOHERENT_MACHINE = {
  initial: "backlog",
  states: ["backlog", "spec", "dev", "test", "done", "staging", "prod"],
  terminal: ["prod"],
  transitions: [
    { type: "MOVE", from: "backlog", to: "spec" },
    { type: "MOVE", from: "spec", to: "dev" },
    // dev->test deliberately MISSING
    { type: "MOVE", from: "test", to: "done" },
    { type: "MOVE", from: "done", to: "staging" },
    { type: "MOVE", from: "staging", to: "prod" },
  ],
};

// A routable backlog card (decide → work) so a bypassed gate would produce visible stdout.
const READY_CARD = {
  id: "c1",
  state: "backlog",
  title: "would-be-routed",
  blocked: false,
  veto_held: false,
  hold_open: false,
  open_questions: [],
  vetoes: [],
  holds: [],
  next_transitions: [],
  transitions_count: 0,
  lease_expiry_ts: null,
  linked_head_sha: null,
  ci_rollup: null,
  children_total: 0,
  children_done: 0,
  current_gen: 0,
  parked_since_ts: null,
};

function startStub() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    const json = (obj) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.url.endsWith("/config")) return json(INCOHERENT_MACHINE);
    if (/\/cards\/[^/]+\/enriched$/.test(req.url)) return json(READY_CARD);
    if (req.url.includes("/cards")) return json({ items: [{ id: "c1", state: "backlog", title: "would-be-routed" }], nextAfterId: null });
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  return { server, seen };
}

test("list-ready fails closed on an incoherent GET /config: non-zero exit, no routing, bails before listing", async () => {
  const { server, seen } = startStub();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  const child = spawn(process.execPath, [LIST_READY], {
    env: {
      ...process.env,
      YDB_API_BASE: `http://127.0.0.1:${port}`,
      YDB_DO_NAME: "coherence-wiring-test",
      YDB_TOKEN: "test.token",
    },
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((res) => child.on("close", res));
  await new Promise((r) => server.close(r));

  assert.notEqual(code, 0, `expected non-zero exit on incoherent config; got ${code}. stderr: ${stderr}`);
  assert.equal(stdout.trim(), "", `fail-closed: expected NO routing output on stdout; got: ${stdout}`);
  assert.match(stderr, /refusing to route/i, `expected a refuse-to-route diagnostic on stderr; got: ${stderr}`);
  assert.ok(
    !seen.some((u) => u.includes("/cards")),
    `must fail closed BEFORE listing cards, but these paths were hit: ${seen.join(", ")}`,
  );
});
