/*
 * advice-cli.test.mjs — hermetic child_process test for advice.mjs, following the node:http stub +
 * spawn pattern from create-cli.test.mjs. Pins the fix for the "advice.mjs hardcodes security-advisor"
 * finding: the acting board identity (which YDB_TOKEN_<ROLE> is required) must follow the dispatched
 * advisor's role, not a fixed one, so a non-security-advisor advisor's (e.g. code-reviewer) clean/advice
 * review is attributed to ITS identity, not silently posted as security-advisor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { projectBoardDir } from "./lib/project-board.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADVICE = join(HERE, "..", "skills", "yarradev-run", "scripts", "advice.mjs");

function startStub() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push({ url: req.url, method: req.method, headers: req.headers, body: body ? JSON.parse(body) : null });
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ outcome: "committed", status: 202, seq: 1, applied: true }));
    });
  });
  return { server, requests };
}

function run(args, { apiBase, doName, ...env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ADVICE, ...args], {
      cwd: projectBoardDir({ apiBase, doName }),
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("advice.mjs --role code-reviewer posts under YDB_TOKEN_CODE_REVIEWER, not security-advisor", async () => {
  const { server, requests } = startStub();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  const { code, stdout, stderr } = await run(
    ["card-1", "abc123", "looks fine", "--role", "code-reviewer"],
    {
      apiBase: `http://127.0.0.1:${port}`,
      doName: "advice-cli-test",
      YDB_TOKEN_CODE_REVIEWER: "code-reviewer.token",
      YDB_TOKEN_SECURITY_ADVISOR: "security-advisor.token",
    },
  );
  await new Promise((r) => server.close(r));

  assert.equal(code, 0, `expected exit 0 on committed; stdout=${stdout} stderr=${stderr}`);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/boards/advice-cli-test/acts");
  assert.equal(requests[0].body.type, "ADVICE");
  assert.equal(requests[0].body.item_id, "card-1");
  assert.deepEqual(requests[0].body.data, { reviewed_head: "abc123", reason: "looks fine" });
  assert.equal(
    requests[0].headers.authorization,
    "Bearer code-reviewer.token",
    "must post under the passed --role's token, not security-advisor's",
  );

  const printed = JSON.parse(stdout.trim());
  assert.equal(printed.ok, true);
});

test("advice.mjs defaults to security-advisor when --role is omitted (backward compatible)", async () => {
  const { server, requests } = startStub();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  await run(["card-2", "def456", "clean"], {
    apiBase: `http://127.0.0.1:${port}`,
    doName: "advice-cli-test",
    YDB_TOKEN_SECURITY_ADVISOR: "security-advisor.token",
  });
  await new Promise((r) => server.close(r));

  assert.equal(requests[0].headers.authorization, "Bearer security-advisor.token");
});

test("advice.mjs falls back to shared YDB_TOKEN when the role's token is unset", async () => {
  const { server, requests } = startStub();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  await run(["card-3", "ghi789", "clean", "--role", "code-reviewer"], {
    apiBase: `http://127.0.0.1:${port}`,
    doName: "advice-cli-test",
    YDB_TOKEN: "shared.token",
  });
  await new Promise((r) => server.close(r));

  assert.equal(requests[0].headers.authorization, "Bearer shared.token");
});

test("advice.mjs exits 2 on missing head (no network call)", async () => {
  const { server, requests } = startStub();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  const { code, stderr } = await run(["card-4"], {
    apiBase: `http://127.0.0.1:${port}`,
    doName: "advice-cli-test",
    YDB_TOKEN: "shared.token",
  });
  await new Promise((r) => server.close(r));

  assert.equal(code, 2);
  assert.match(stderr, /usage: advice\.mjs/);
  assert.equal(requests.length, 0, "must not hit the network on a usage error");
});
