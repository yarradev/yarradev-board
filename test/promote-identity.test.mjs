/*
 * promote-identity.test.mjs — Phase 2b Task 5. The barrier fan-in leg is now promote-shaped (CLAIM-free)
 * and carries the stage's `promoteAs` role, so promote.mjs takes an optional 3rd `[role]` arg. This pins
 * the load-bearing contract: the MOVE that promote.mjs posts is authenticated under the RIGHT board
 * identity —
 *   - default (2-arg, human gate staging→prod): `releaser` → YDB_TOKEN_RELEASER (byte-behavior UNCHANGED),
 *   - 3-arg with `analyst` (epic barrier integrating→done): `analyst` → YDB_TOKEN_ANALYST.
 *
 * Hermetic (no real network): a local node:http stub serves the card's current gen at GET
 * /cards/:id/enriched and captures the Authorization bearer on the POST /acts (the MOVE). Identity on
 * the yarradev board is ALWAYS the bearer token (BoardClient sends no by/role field), so asserting the
 * bearer IS asserting the posting identity.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMOTE = join(HERE, "..", "skills", "yarradev-board-run", "scripts", "promote.mjs");

function startStub() {
  const acts = []; // { authorization, body } captured per POST /acts (the MOVE)
  const server = createServer((req, res) => {
    if (/\/cards\/[^/]+\/enriched$/.test(req.url) && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: "x", state: "integrating", current_gen: 4 }));
    }
    if (req.url.endsWith("/acts") && req.method === "POST") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        acts.push({ authorization: req.headers.authorization, body: JSON.parse(raw || "{}") });
        res.writeHead(200, { "content-type": "application/json" });
        // A committed AppendResult so emit() exits 0.
        res.end(JSON.stringify({ outcome: "committed", status: 202, seq: 5, applied: true }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  return { server, acts };
}

async function runPromote(args, env) {
  const { server, acts } = startStub();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const child = spawn(process.execPath, [PROMOTE, ...args], {
    env: {
      ...process.env,
      YDB_API_BASE: `http://127.0.0.1:${port}`,
      YDB_DO_NAME: "promote-identity-test",
      ...env,
    },
  });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  const code = await new Promise((res) => child.on("close", res));
  await new Promise((r) => server.close(r));
  return { code, stdout, acts };
}

// Isolate token env: strip any ambient YDB_TOKEN* so a real one can't leak into the identity assertion.
const CLEAN = Object.fromEntries(Object.keys(process.env).filter((k) => k.startsWith("YDB_TOKEN")).map((k) => [k, undefined]));

test("promote.mjs default (2-arg) posts the MOVE as releaser (human gate, unchanged)", async () => {
  const { code, acts } = await runPromote(["c1", "prod"], {
    ...CLEAN,
    YDB_TOKEN_RELEASER: "rel.tok",
    YDB_TOKEN_ANALYST: "analyst.tok",
    YDB_TOKEN: "shared.tok",
  });
  assert.equal(code, 0, "promote should exit 0 on a committed MOVE");
  assert.equal(acts.length, 1, "exactly one MOVE posted");
  assert.equal(acts[0].body.type, "MOVE");
  assert.equal(acts[0].body.data.to, "prod");
  assert.equal(acts[0].body.gen, 4, "MOVEs at the card's current gen (no CLAIM bump)");
  assert.equal(acts[0].authorization, "Bearer rel.tok", "human gate promotes under the releaser identity");
});

test("promote.mjs 3-arg role=analyst posts the MOVE as analyst (epic barrier)", async () => {
  const { code, acts } = await runPromote(["e1", "done", "analyst"], {
    ...CLEAN,
    YDB_TOKEN_RELEASER: "rel.tok",
    YDB_TOKEN_ANALYST: "analyst.tok",
    YDB_TOKEN: "shared.tok",
  });
  assert.equal(code, 0, "promote should exit 0 on a committed MOVE");
  assert.equal(acts.length, 1, "exactly one MOVE posted");
  assert.equal(acts[0].body.data.to, "done");
  assert.equal(acts[0].authorization, "Bearer analyst.tok", "barrier promotes under the promoteAs (analyst) identity");
});
