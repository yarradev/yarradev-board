/*
 * create-cli.test.mjs — hermetic child_process test for create.mjs (Phase 2b Task 6), following the
 * node:http stub + spawn pattern from coherence-wiring.test.mjs. Asserts the POSTed CREATE body for a
 * --lane fast child with --parent + --type epic, and the exit-2 usage-error contract on a missing title.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CREATE = join(HERE, "..", "skills", "yarradev-board-run", "scripts", "create.mjs");

function startStub() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push({ url: req.url, method: req.method, body: body ? JSON.parse(body) : null });
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ outcome: "committed", status: 202, seq: 1, applied: true }));
    });
  });
  return { server, requests };
}

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CREATE, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("create.mjs posts CREATE with --lane fast → state:dev, --parent threaded, --type epic honored", async () => {
  const { server, requests } = startStub();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  const { code, stdout } = await run(
    ["Decompose into workers", "--type", "epic", "--parent", "epic-1", "--lane", "fast"],
    {
      YDB_API_BASE: `http://127.0.0.1:${port}`,
      YDB_DO_NAME: "create-cli-test",
      YDB_TOKEN: "test.token",
    },
  );
  await new Promise((r) => server.close(r));

  assert.equal(code, 0, `expected exit 0 on committed; stdout=${stdout}`);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/boards/create-cli-test/acts");
  assert.equal(requests[0].body.type, "CREATE");
  assert.equal(requests[0].body.gen, null);
  assert.ok(typeof requests[0].body.item_id === "string" && requests[0].body.item_id.length > 0, "item_id must be minted");
  assert.deepEqual(requests[0].body.data, {
    type: "epic",
    title: "Decompose into workers",
    state: "dev",
    parent_id: "epic-1",
  });

  const printed = JSON.parse(stdout.trim());
  assert.equal(printed.ok, true);
  assert.equal(printed.id, requests[0].body.item_id);
});

test("create.mjs --lane full → state:spec", async () => {
  const { server, requests } = startStub();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  await run(["Design the thing", "--lane", "full"], {
    YDB_API_BASE: `http://127.0.0.1:${port}`,
    YDB_DO_NAME: "create-cli-test",
    YDB_TOKEN: "test.token",
  });
  await new Promise((r) => server.close(r));

  assert.equal(requests[0].body.data.state, "spec");
});

test("create.mjs omits state when neither --state nor --lane is given (board defaults to backlog)", async () => {
  const { server, requests } = startStub();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  await run(["Just a title"], {
    YDB_API_BASE: `http://127.0.0.1:${port}`,
    YDB_DO_NAME: "create-cli-test",
    YDB_TOKEN: "test.token",
  });
  await new Promise((r) => server.close(r));

  assert.deepEqual(requests[0].body.data, { type: "story", title: "Just a title" });
});

test("create.mjs --lane wins over --state when both are given", async () => {
  const { server, requests } = startStub();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  await run(["Both given", "--state", "test", "--lane", "fast"], {
    YDB_API_BASE: `http://127.0.0.1:${port}`,
    YDB_DO_NAME: "create-cli-test",
    YDB_TOKEN: "test.token",
  });
  await new Promise((r) => server.close(r));

  assert.equal(requests[0].body.data.state, "dev");
});

test("create.mjs exits 2 on missing title (no network call)", async () => {
  const { server, requests } = startStub();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  const { code, stderr } = await run(["--type", "story"], {
    YDB_API_BASE: `http://127.0.0.1:${port}`,
    YDB_DO_NAME: "create-cli-test",
    YDB_TOKEN: "test.token",
  });
  await new Promise((r) => server.close(r));

  assert.equal(code, 2);
  assert.match(stderr, /usage: create\.mjs/);
  assert.equal(requests.length, 0, "must not hit the network on a usage error");
});
