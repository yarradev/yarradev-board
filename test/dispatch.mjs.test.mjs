/*
 * dispatch.mjs.test.mjs — pins GH #43: the portable Node port of ~/work/tools/yarradev-dispatch.
 *
 * Two layers:
 *   1. PURE unit tests — frontmatter parsing, combined-prompt layout, worktree-flag role set, 529
 *      classification, error-envelope shape, manifest entry shapes, sanitizeEnv. Fast, no I/O.
 *   2. RUNNER retry loop — runRetryLoop with an injected invokeClaude (deterministic, no spawn) pins the
 *      loop logic: retries fire on 529, backoff schedule, truncate-between-attempts, break on success,
 *      exhaust on always-529. PLUS one end-to-end subprocess test that drives the REAL runner via a
 *      fake claude binary (YARRADEV_CLAUDE_BIN) + temp manifest/verdict, proving the spawn path and
 *      arg wiring (the task's requested shape). Backoff overridden to 0ms so the test doesn't sleep.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractField,
  extractBody,
  parseFrontmatter,
  buildCombinedPrompt,
  worktreeFlagFor,
  is529Retryable,
  classifyError,
  buildDetail,
  buildErrorEnvelope,
  pendingEntry,
  doneEntry,
  utcNow,
  sanitizeEnv,
  runRetryLoop,
  finalizeRunner,
} from "../skills/yarradev-run/scripts/dispatch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DISPATCH_MJS = join(HERE, "..", "skills", "yarradev-run", "scripts", "dispatch.mjs");

// A realistic agent fixture (frontmatter + body), mirroring agents/developer.md's shape.
const AGENT_MD = `---
name: developer
description: yarradev Developer
tools: Read, Write, Edit, Bash, Grep, Glob
model: opus
effort: high
role: developer
---

# Role: Developer (yarradev)

You are a stateless yarradev Developer, spawned for one card, then exit.
`;

// ============================================================================
// 1. Frontmatter parsing (extractField / extractBody / parseFrontmatter + defaults)
// ============================================================================

test("extractField: returns the first `^key:` value with leading whitespace trimmed", () => {
  assert.equal(extractField(AGENT_MD, "model"), "opus");
  assert.equal(extractField(AGENT_MD, "effort"), "high");
  assert.equal(extractField(AGENT_MD, "tools"), "Read, Write, Edit, Bash, Grep, Glob");
});

test("extractField: does not match `models:` (the prefix must be `key:` exactly)", () => {
  const md = "models: sonnet\nmodel: opus\n";
  assert.equal(extractField(md, "model"), "opus", "matches model:, skips models:");
});

test("extractField: trims spaces AND tabs after the colon (sed [[:space:]] parity)", () => {
  assert.equal(extractField("model:\topus", "model"), "opus");
  assert.equal(extractField("model:   opus", "model"), "opus");
});

test("extractField: empty string when the key is absent", () => {
  assert.equal(extractField("no frontmatter here", "model"), "");
});

test("extractBody: returns everything after the second `---` fence", () => {
  const body = extractBody(AGENT_MD);
  // The bash awk prints every line after c>=2, INCLUDING the blank line that follows the 2nd `---`.
  // So the body faithfully begins with a leading newline then `# Role: Developer`.
  assert.match(body, /# Role: Developer/);
  assert.match(body, /spawned for one card/);
  assert.equal(body.includes("---"), false, "no fence lines in the body");
});

test("extractBody: a `---` appearing later in the body is NOT counted as a fence (only the first two)", () => {
  const md = "---\nmodel: x\n---\nbody with --- separator\nmore\n";
  assert.equal(extractBody(md), "body with --- separator\nmore\n");
});

test("parseFrontmatter: applies the bash defaults (model=sonnet, effort=low, tools='Read, Bash')", () => {
  const { model, effort, tools } = parseFrontmatter("---\nname: x\n---\nbody\n");
  assert.equal(model, "sonnet");
  assert.equal(effort, "low");
  assert.equal(tools, "Read, Bash");
});

test("parseFrontmatter: returns model/effort/tools/body for a real-shaped agent", () => {
  const parsed = parseFrontmatter(AGENT_MD);
  assert.deepEqual(
    { model: parsed.model, effort: parsed.effort, tools: parsed.tools },
    { model: "opus", effort: "high", tools: "Read, Write, Edit, Bash, Grep, Glob" },
  );
  assert.match(parsed.body, /# Role: Developer/);
});

// ============================================================================
// 2. Combined-prompt layout (exact byte-for-byte match with the bash tool)
// ============================================================================

test("buildCombinedPrompt: matches the bash `=== Role instructions === / body / '' / === Card context === / cardPrompt` layout", () => {
  const out = buildCombinedPrompt("ROLE BODY", "CARD CONTEXT");
  // echo adds \n after each line; cat emits the file verbatim (no added trailing newline).
  assert.equal(
    out,
    "=== Role instructions (append to your system prompt) ===\n" +
      "ROLE BODY\n\n" +
      "=== Card context ===\n" +
      "CARD CONTEXT",
  );
});

test("buildCombinedPrompt: preserves multi-line role body and card prompt verbatim", () => {
  const out = buildCombinedPrompt("line1\nline2", "ctx1\nctx2");
  assert.match(out, /line1\nline2/);
  assert.match(out, /ctx1\nctx2/);
});

// ============================================================================
// 3. worktree-flag role set (#42: dev/releaser/tester/devops yes; read-only advisors no)
// ============================================================================

test("worktreeFlagFor: developer/releaser/tester/devops get the flag", () => {
  assert.equal(worktreeFlagFor("developer", "c1"), "--worktree yarradev-c1");
  assert.equal(worktreeFlagFor("releaser", "c1"), "--worktree yarradev-c1");
  assert.equal(worktreeFlagFor("tester", "c1"), "--worktree yarradev-c1");
  assert.equal(worktreeFlagFor("devops", "c1"), "--worktree yarradev-c1");
});

test("worktreeFlagFor: read-only advisors get NO flag (empty string)", () => {
  assert.equal(worktreeFlagFor("designer", "c1"), "");
  assert.equal(worktreeFlagFor("analyst", "c1"), "");
  assert.equal(worktreeFlagFor("code-reviewer", "c1"), "");
  assert.equal(worktreeFlagFor("security-advisor", "c1"), "");
});

test("worktreeFlagFor: the cardId is interpolated into the worktree name", () => {
  assert.equal(worktreeFlagFor("developer", "card-42"), "--worktree yarradev-card-42");
});

test("worktreeFlagFor: explicit override=true forces the flag even for a read-only role", () => {
  assert.equal(worktreeFlagFor("designer", "c1", true), "--worktree yarradev-c1");
});
test("worktreeFlagFor: explicit override=false suppresses the flag even for a write role", () => {
  assert.equal(worktreeFlagFor("developer", "c1", false), "");
});
test("worktreeFlagFor: override=undefined keeps the WORKTREE_ROLES default", () => {
  assert.equal(worktreeFlagFor("developer", "c1", undefined), "--worktree yarradev-c1");
  assert.equal(worktreeFlagFor("designer", "c1", undefined), "");
});

// ============================================================================
// 4. 529 detection + error classification (gateway_529 / crash / empty)
// ============================================================================

test("is529Retryable: matches 529 / overloaded / temporarily overloaded (case-insensitive)", () => {
  assert.equal(is529Retryable("Error 529 overloaded"), true);
  assert.equal(is529Retryable("api.z.ai temporarily overloaded"), true);
  assert.equal(is529Retryable("OVERLOADED"), true);
  assert.equal(is529Retryable("everything fine"), false);
  assert.equal(is529Retryable(""), false);
});

test("classifyError: gateway_529 when the verdict contains 529|overloaded", () => {
  assert.equal(classifyError("Error: 529 Service Overloaded"), "gateway_529");
  assert.equal(classifyError("api temporarily overloaded"), "gateway_529");
});

test("classifyError: empty when the verdict is blank (bash `! -s`)", () => {
  assert.equal(classifyError(""), "empty");
});

test("classifyError: crash for any other non-empty failure", () => {
  assert.equal(classifyError("Error: command not found"), "crash");
  assert.equal(classifyError("SyntaxError: unexpected token"), "crash");
});

test("classifyError precedence: a 529 verdict with other text still classifies gateway_529", () => {
  assert.equal(classifyError("some preamble\n529 overloaded\nmore"), "gateway_529");
});

// ============================================================================
// 5. Error envelope + detail (buildDetail / buildErrorEnvelope — GH #44 shape)
// ============================================================================

test("buildDetail: last 3 lines joined with spaces, truncated to 240 chars", () => {
  const verdict = "l1\nl2\nl3\nl4\nl5";
  assert.equal(buildDetail(verdict), "l3 l4 l5", "last 3 lines");
  // 240-char truncation
  const long = "x".repeat(300);
  assert.equal(buildDetail(long).length, 240, "truncated to 240");
});

test("buildErrorEnvelope: emits the bare GH #44 shape on a 529 verdict", () => {
  const line = buildErrorEnvelope("Error: 529 temporarily overloaded\nmore");
  const parsed = JSON.parse(line);
  assert.deepEqual(
    { status: parsed.status, error_type: parsed.error_type },
    { status: "error", error_type: "gateway_529" },
  );
  assert.equal(typeof parsed.detail, "string");
});

test("buildErrorEnvelope: crash classification on a non-529 failure", () => {
  const parsed = JSON.parse(buildErrorEnvelope("Error: ENOENT claude"));
  assert.equal(parsed.error_type, "crash");
});

test("buildErrorEnvelope: empty classification on a blank verdict", () => {
  const parsed = JSON.parse(buildErrorEnvelope(""));
  assert.equal(parsed.error_type, "empty");
});

test("buildErrorEnvelope: produces VALID json even when the verdict contains quotes/backslashes", () => {
  const line = buildErrorEnvelope('bad "quote" and back\\slash\n529');
  const parsed = JSON.parse(line); // throws if invalid
  assert.equal(parsed.error_type, "gateway_529");
  assert.ok(parsed.detail.includes('"quote"') || parsed.detail.includes("quote"));
});

// ============================================================================
// 6. Manifest entry shapes (pendingEntry / doneEntry — key order + shape)
// ============================================================================

test("pendingEntry: emits the exact bash shape with dispatchedAt", () => {
  const line = pendingEntry({
    cardId: "c1",
    verdictPath: "/v/verdict.txt",
    gen: "3",
    role: "developer",
    dispatchedAt: "2026-07-07T01:02:03Z",
  });
  assert.deepEqual(JSON.parse(line), {
    status: "pending",
    cardId: "c1",
    verdictPath: "/v/verdict.txt",
    gen: "3",
    role: "developer",
    dispatchedAt: "2026-07-07T01:02:03Z",
  });
  // key order preserved (status, cardId, verdictPath, gen, role, dispatchedAt) — pass.mjs/in-flight rely on this shape.
  assert.equal(
    Object.keys(JSON.parse(line)).join(","),
    "status,cardId,verdictPath,gen,role,dispatchedAt",
  );
});

test("doneEntry: emits the exact bash shape with completedAt", () => {
  const line = doneEntry({
    cardId: "c1",
    verdictPath: "/v/verdict.txt",
    gen: "3",
    role: "developer",
    completedAt: "2026-07-07T01:03:04Z",
  });
  assert.deepEqual(JSON.parse(line), {
    status: "done",
    cardId: "c1",
    verdictPath: "/v/verdict.txt",
    gen: "3",
    role: "developer",
    completedAt: "2026-07-07T01:03:04Z",
  });
  assert.equal(
    Object.keys(JSON.parse(line)).join(","),
    "status,cardId,verdictPath,gen,role,completedAt",
  );
});

test("utcNow: ISO-8601 UTC with whole-second precision and a trailing Z", () => {
  assert.match(utcNow(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

// ============================================================================
// 7. sanitizeEnv (defense-in-depth, GH #25 — strips YDB_TOKEN* the runner must not see)
// ============================================================================

test("sanitizeEnv: strips every YDB_TOKEN* key (case-insensitive), preserves the rest", () => {
  const out = sanitizeEnv({
    PATH: "/usr/bin",
    HOME: "/h",
    YDB_TOKEN: "x",
    YDB_TOKEN_DEVELOPER: "y",
    ydb_token_lower: "z",
    CLOUDFLARE_API_TOKEN: "cf",
    GITHUB_TOKEN: "gh",
  });
  assert.equal(out.YDB_TOKEN, undefined);
  assert.equal(out.YDB_TOKEN_DEVELOPER, undefined);
  assert.equal(out.ydb_token_lower, undefined);
  assert.equal(out.PATH, "/usr/bin");
  assert.equal(out.CLOUDFLARE_API_TOKEN, "cf");
  assert.equal(out.GITHUB_TOKEN, "gh");
});

test("sanitizeEnv: returns a distinct copy (does not mutate the input)", () => {
  const input = { YDB_TOKEN: "x", PATH: "/p" };
  const out = sanitizeEnv(input);
  assert.equal(input.YDB_TOKEN, "x", "input untouched");
  assert.notEqual(out, input);
  assert.equal(out.YDB_TOKEN, undefined);
});

// ============================================================================
// 8. runRetryLoop — injected invokeClaude (deterministic, no spawn/sleep)
// ============================================================================

test("runRetryLoop: retries a 529 then breaks on success; backoff + truncate-between-attempts fired", async () => {
  const writes = []; // captured verdict contents
  const appends = [];
  const sleeps = [];
  let calls = 0;
  const { rc, attempts } = await runRetryLoop({
    invokeClaude: () => {
      calls++;
      // 529 twice, then succeed.
      if (calls <= 2) return { rc: 1, out: "Error 529 overloaded" };
      return { rc: 0, out: '{"status":"done"}' };
    },
    verdictPath: "/v/verdict.txt",
    maxAttempts: 4,
    backoffScheduleMs: [20000, 40000, 80000],
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    writeFileSync: (_p, c) => writes.push({ op: "write", c }),
    appendFileSync: (_p, c) => appends.push({ op: "append", c }),
  });
  assert.equal(rc, 0, "success on the 3rd attempt");
  assert.equal(attempts, 3);
  assert.equal(calls, 3);
  // backoff fired before attempts 2 and 3 (20s, 40s).
  assert.deepEqual(sleeps, [20000, 40000]);
  // truncate-between-attempts: a write of "" followed each 529 retry (after the initial attempt-1 write).
  assert.ok(writes.some((w) => w.c === ""), "verdict truncated between attempts");
});

test("runRetryLoop: a non-529 failure does NOT retry (breaks immediately)", async () => {
  let calls = 0;
  const { rc, attempts } = await runRetryLoop({
    invokeClaude: () => {
      calls++;
      return { rc: 1, out: "Error: ENOENT something" };
    },
    verdictPath: "/v/verdict.txt",
    maxAttempts: 4,
    backoffScheduleMs: [20000, 40000],
    sleep: () => Promise.resolve(),
    writeFileSync: () => {},
    appendFileSync: () => {},
  });
  assert.equal(rc, 1);
  assert.equal(attempts, 1, "no retry on a non-529 crash");
  assert.equal(calls, 1);
});

test("runRetryLoop: always-529 exhausts MAX_ATTEMPTS, then finalizeRunner appends the gateway_529 envelope + done", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "dispatch-"));
  const verdictPath = join(tmp, "verdict.txt");
  const manifestPath = join(tmp, "manifest.jsonl");
  writeFileSync(verdictPath, "");
  writeFileSync(manifestPath, "");

  let calls = 0;
  const { rc, attempts } = await runRetryLoop({
    invokeClaude: () => {
      calls++;
      return { rc: 1, out: "529 temporarily overloaded" };
    },
    verdictPath,
    maxAttempts: 3,
    backoffScheduleMs: [0, 0], // no real sleeping
    sleep: () => Promise.resolve(),
  });
  assert.equal(rc, 1);
  assert.equal(attempts, 3, "exhausted all 3 attempts");

  // finalize: appends the error envelope to the verdict + the done line to the manifest.
  finalizeRunner({
    rc,
    verdictPath,
    manifestPath,
    doneLine: doneEntry({
      cardId: "c1",
      verdictPath,
      gen: "2",
      role: "developer",
      completedAt: "2026-07-07T01:00:00Z",
    }),
  });

  const verdict = readFileSync(verdictPath, "utf8");
  const manifest = readFileSync(manifestPath, "utf8");
  // The LAST non-empty line of the verdict is the bare error envelope (GH #44).
  const lines = verdict.split("\n").filter((l) => l.trim());
  const envelope = JSON.parse(lines[lines.length - 1]);
  assert.equal(envelope.status, "error");
  assert.equal(envelope.error_type, "gateway_529");
  // The done entry landed on the manifest.
  const mlines = manifest.split("\n").filter((l) => l.trim());
  const done = JSON.parse(mlines[mlines.length - 1]);
  assert.equal(done.status, "done");
  assert.equal(done.verdictPath, verdictPath);
  rmSync(tmp, { recursive: true, force: true });
});

// ============================================================================
// 9. End-to-end runner via a fake claude binary (YARRADEV_CLAUDE_BIN) — the task's requested shape
// ============================================================================

test("RUNNER e2e: retries a 529 (fake claude) then appends the envelope + done on exhaustion", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dispatch-e2e-"));
  try {
    // --- a fake claude: always 529, counts calls via a file ---
    const counter = join(tmp, "count.txt");
    writeFileSync(counter, "0");
    const fakeClaude = join(tmp, "fake-claude.mjs");
    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { body += c; });
process.stdin.on("end", () => {
  const n = Number(readFileSync(process.env.FAKE_COUNT, "utf8") || "0") + 1;
  writeFileSync(process.env.FAKE_COUNT, String(n));
  process.stdout.write("Error from api.z.ai: 529 Service overloaded\\n");
  process.exit(1);
});
`,
    );
    chmodSync(fakeClaude, 0o755);

    const verdict = join(tmp, "verdict.txt");
    const manifest = join(tmp, "manifest.jsonl");
    const prompt = join(tmp, "prompt.txt");
    writeFileSync(verdict, "");
    writeFileSync(manifest, "");
    writeFileSync(prompt, "=== Card context ===\ncard body\n");

    // Drive the REAL runner subprocess: node dispatch.mjs --run ... with a short backoff override.
    const r = spawnSync(
      process.execPath,
      [
        DISPATCH_MJS,
        "--run",
        "developer",
        "c-99",
        prompt,
        "--gen",
        "5",
        "--verdict",
        verdict,
        "--model",
        "sonnet",
        "--effort",
        "low",
        "--tools",
        "Read, Bash",
        "--worktree-flag",
        "",
        "--orig-pwd",
        tmp,
        "--manifest",
        manifest,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dirname(fakeClaude)}:${process.env.PATH ?? ""}`,
          YARRADEV_CLAUDE_BIN: fakeClaude,
          YARRADEV_DISPATCH_MAX_ATTEMPTS: "3",
          YARRADEV_DISPATCH_BACKOFF_MS: "0,0,0",
          FAKE_COUNT: counter,
        },
      },
    );

    assert.equal(r.status, 0, `runner exited 0 (it always lands done). stderr: ${r.stderr ?? ""}`);

    // Retries fired: the fake was invoked MAX_ATTEMPTS times.
    const attempts = Number(readFileSync(counter, "utf8"));
    assert.equal(attempts, 3, "claude -p invoked once per attempt (3 retries on always-529)");

    // The verdict ends with the bare error envelope (gateway_529).
    const verdictText = readFileSync(verdict, "utf8");
    const vlines = verdictText.split("\n").filter((l) => l.trim());
    const envelope = JSON.parse(vlines[vlines.length - 1]);
    assert.equal(envelope.status, "error");
    assert.equal(envelope.error_type, "gateway_529");

    // The done entry landed on the manifest.
    const mlines = readFileSync(manifest, "utf8").split("\n").filter((l) => l.trim());
    const done = JSON.parse(mlines[mlines.length - 1]);
    assert.equal(done.status, "done");
    assert.equal(done.cardId, "c-99");
    assert.equal(done.verdictPath, verdict);
    assert.equal(done.gen, "5");
    assert.equal(done.role, "developer");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
