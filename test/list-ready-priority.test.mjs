/*
 * list-ready-priority.test.mjs — hermetic test for priority sort in list-ready.mjs.
 * Stubs the board API to return cards with different priorities and types, then
 * asserts stdout lines are in (epic_priority, card_priority, id) order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIST_READY = join(HERE, "..", "skills", "yarradev-run", "scripts", "list-ready.mjs");

function run(env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LIST_READY], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("list-ready emits cards in (epic priority, card priority, id) order", async () => {
  // Stub: GET /config returns a machine coherent with the default lifecycle
  const lifecycle = {
    backlog: { owner: "designer", to: "spec" },
    spec: { owner: "designer", to: "dev" },
    dev: { owner: "developer", to: "test", gate: "mechanical" },
    test: { owner: "tester", to: "done" },
    done: { owner: "releaser", to: "staging", gate: "judgement" },
    staging: { owner: "", to: "prod", gate: "human" },
    prod: { owner: "", to: null },
    epic_analysis: { owner: "analyst", to: "epic_decompose", gate: "judgement" },
    epic_decompose: { owner: "analyst", to: "epic_integrating", gate: "judgement" },
    epic_integrating: { owner: "", to: "epic_done", gate: "barrier", promoteAs: "analyst" },
    epic_done: { owner: "", to: null },
  };

  // Build a coherent machine from the lifecycle (mirrors assertLifecycleCoherent's check)
  const transitions = [];
  for (const [state, cfg] of Object.entries(lifecycle)) {
    if (cfg.to) {
      transitions.push({ from: state, to: cfg.to, type: "MOVE" });
    }
  }
  const states = [...new Set([
    ...Object.keys(lifecycle),
    ...transitions.map((t) => t.from),
    ...transitions.map((t) => t.to),
  ])];
  const machine = { states, transitions, terminal: ["prod", "epic_done"] };

  // Cards: epics should be picked in priority order, stories within epics by own priority
  // Epic "Audit" (p: 20) has story "Export" (p: 1) — should come FIRST
  // Epic "SSO" (p: 10) has stories "OAuth" (p: 2) and "JWT" (p: 1) — SSO epic is higher pri
  // Standalone story "Refactor" (p: 50) has no parent
  const cards = [
    { id: "story-jwt",     state: "dev", title: "JWT refresh",  type: "story", parent_id: "epic-sso",   priority: 2 },
    { id: "story-refactor", state: "spec", title: "Refactor DB", type: "story", priority: 50 },
    { id: "epic-audit",    state: "epic_analysis", title: "Audit Log", type: "epic", priority: 20 },
    { id: "epic-sso",      state: "epic_analysis", title: "SSO",       type: "epic", priority: 10 },
    { id: "story-oauth",   state: "dev", title: "OAuth flow",  type: "story", parent_id: "epic-sso",   priority: 2 },
    { id: "story-export",  state: "dev", title: "Export CSV",  type: "story", parent_id: "epic-audit", priority: 1 },
  ];

  // Expected order by (epA, card_priority, id):
  // Group epA=10 (epic-sso): story-oauth (p:2, id < story-jwt), story-jwt (p:2), epic-sso (p:10)
  // Group epA=20 (epic-audit): story-export (p:1), epic-audit (p:20)
  // Group epA=50 (standalone): story-refactor (p:50)

  const urlPath = (req) => new URL(req.url, `http://${req.headers.host ?? "localhost"}`).pathname;

  const server = createServer((req, res) => {
    const path = urlPath(req);
    if (path === "/boards/test-priority/config" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(machine));
      return;
    }
    if (path === "/boards/test-priority/cards" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: cards }));
      return;
    }
    // Enriched card fetch: /boards/test-priority/cards/<id>/enriched
    const match = path.match(/\/boards\/test-priority\/cards\/(.+)\/enriched/);
    if (match && req.method === "GET") {
      const id = match[1];
      const card = cards.find((c) => c.id === id);
      if (!card) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      // Enriched view includes parent_id and priority
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ...card,
        current_gen: 1,
        open_questions: [],
        vetoes: [],
        next_transitions: [{ from: card.state, to: lifecycle[card.state]?.to, type: "MOVE" }],
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  const { code, stdout } = await run({
    YDB_API_BASE: `http://127.0.0.1:${port}`,
    YDB_DO_NAME: "test-priority",
    YDB_TOKEN: "test.token",
  });
  await new Promise((r) => server.close(r));

  assert.equal(code, 0, `expected exit 0, got ${code}; stderr not captured but check manually`);

  const lines = stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ids = lines.map((l) => l.id);

  assert.deepEqual(ids, [
    "story-jwt",
    "story-oauth",
    "epic-sso",
    "story-export",
    "epic-audit",
    "story-refactor",
  ], "cards must be in (epic priority, card priority, id) order");
});
