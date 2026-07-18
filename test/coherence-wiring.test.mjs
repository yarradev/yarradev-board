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
import { projectBoardDir } from "./lib/project-board.mjs";

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

// Same shape as the shipped board.example.json lifecycle (states/edges), so assertLifecycleCoherent
// still passes — it validates against machine.states/transitions, not machine.lifecycle. This machine
// ALSO serves a `lifecycle` field (issue #83): backlog's owner differs from the local board.json's
// ("developer" vs the shipped "designer") so a routed card's `role` proves which lifecycle won.
const BOARD_SERVED_MACHINE = {
  initial: "backlog",
  states: [
    "backlog", "spec", "dev", "test", "done", "staging", "prod",
    "epic_analysis", "epic_decompose", "epic_integrating", "epic_done",
  ],
  terminal: ["prod", "epic_done"],
  transitions: [
    { type: "MOVE", from: "backlog", to: "spec" },
    { type: "MOVE", from: "spec", to: "dev" },
    { type: "MOVE", from: "dev", to: "test" },
    { type: "MOVE", from: "test", to: "done" },
    { type: "MOVE", from: "done", to: "staging" },
    { type: "MOVE", from: "staging", to: "prod" },
    { type: "MOVE", from: "epic_analysis", to: "epic_decompose" },
    { type: "MOVE", from: "epic_decompose", to: "epic_integrating" },
    { type: "MOVE", from: "epic_integrating", to: "epic_done" },
  ],
  lifecycle: {
    backlog: { owner: "developer", to: "spec" }, // differs from board.example.json's "designer"
    spec: { owner: "designer", to: "dev" },
    dev: { owner: "developer", to: "test" },
    test: { owner: "tester", to: "done" },
    done: { owner: "releaser", to: "staging" },
    staging: { owner: "", to: "prod" },
    prod: { owner: "", to: null },
    epic_analysis: { owner: "analyst", to: "epic_decompose" },
    epic_decompose: { owner: "analyst", to: "epic_integrating" },
    epic_integrating: { owner: "", to: "epic_done", promoteAs: "analyst" },
    epic_done: { owner: "", to: null },
  },
};

test("list-ready routes with the board-served machine.lifecycle when present (issue #83), not the local board.json lifecycle", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    const json = (obj) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.url.endsWith("/config")) return json(BOARD_SERVED_MACHINE);
    if (/\/cards\/[^/]+\/enriched$/.test(req.url)) return json(READY_CARD);
    if (req.url.includes("/cards")) return json({ items: [{ id: "c1", state: "backlog", title: "would-be-routed" }], nextAfterId: null });
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  const child = spawn(process.execPath, [LIST_READY], {
    cwd: projectBoardDir({ apiBase: `http://127.0.0.1:${port}`, doName: "coherence-wiring-test" }),
    env: {
      ...process.env,
      YDB_TOKEN: "test.token",
    },
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((res) => child.on("close", res));
  await new Promise((r) => server.close(r));

  assert.equal(code, 0, `expected clean exit; got ${code}. stderr: ${stderr}`);
  const line = JSON.parse(stdout.trim());
  assert.equal(line.role, "developer", `expected the board-served lifecycle's backlog owner ("developer") to win, not board.json's "designer"; stdout: ${stdout}`);
});

test("list-ready fails closed on an incoherent GET /config: non-zero exit, no routing, bails before listing", async () => {
  const { server, seen } = startStub();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  const child = spawn(process.execPath, [LIST_READY], {
    cwd: projectBoardDir({ apiBase: `http://127.0.0.1:${port}`, doName: "coherence-wiring-test" }),
    env: {
      ...process.env,
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
