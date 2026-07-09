/*
 * dispatch-native.test.mjs — GH #51: native dispatch mode emits a dispatch-request for the host
 * conductor to fulfill via its Agent tool, instead of spawning an external `claude -p`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDispatchRequest } from "../skills/yarradev-run/scripts/dispatch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DISPATCH = join(HERE, "..", "skills", "yarradev-run", "scripts", "dispatch.mjs");

test("buildDispatchRequest: assembles the full request with action tag and combined promptPath", () => {
  const req = buildDispatchRequest({
    role: "developer", cardId: "card-1", verdictPath: "/t/v.txt", gen: "7",
    promptPath: "/t/prompt.txt", model: "sonnet", effort: "low", tools: "Read, Bash", worktreeFlag: "--worktree yarradev-card-1",
  });
  assert.deepEqual(req, {
    action: "dispatch-request", role: "developer", cardId: "card-1", verdictPath: "/t/v.txt", gen: "7",
    promptPath: "/t/prompt.txt", model: "sonnet", effort: "low", tools: "Read, Bash", worktreeFlag: "--worktree yarradev-card-1",
    subagentType: undefined,
  });
});

test("buildDispatchRequest: carries subagentType", () => {
  const req = buildDispatchRequest({
    role: "developer", cardId: "c1", verdictPath: "/v", gen: "1", promptPath: "/p",
    model: "opus", effort: "high", tools: "Read", worktreeFlag: "--worktree yarradev-c1", subagentType: "general-purpose",
  });
  assert.equal(req.subagentType, "general-purpose");
  assert.equal(req.action, "dispatch-request");
});

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "yd-native-"));
  const agentsDir = join(dir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  // Minimal role file with frontmatter (model/effort/tools) + body.
  writeFileSync(join(agentsDir, "developer.md"), "---\nmodel: sonnet\neffort: low\ntools: Read, Bash, Edit\n---\nDo the dev work.\n");
  const promptFile = join(dir, "card-prompt.txt");
  writeFileSync(promptFile, "Card: implement X\n");
  return { dir, agentsDir, promptFile };
}

test("native invoke: prints a dispatch-request, records pending, does NOT block on a runner", () => {
  const { dir, promptFile } = sandbox();
  const r = spawnSync(process.execPath, [DISPATCH, "developer", "card-9", promptFile], {
    encoding: "utf8",
    env: {
      ...process.env,
      YARRADEV_DISPATCH_MODE: "native",
      YARRADEV_STATE_DIR: dir,
      CLAUDE_PLUGIN_ROOT: dir, // resolveAgentFile → <root>/agents/<role>.md
    },
  });
  assert.equal(r.status, 0, r.stderr);
  const req = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(req.action, "dispatch-request");
  assert.equal(req.role, "developer");
  assert.equal(req.cardId, "card-9");
  assert.equal(req.model, "sonnet");
  assert.ok(req.verdictPath && req.promptPath, "carries verdictPath + promptPath");
  // combined prompt file exists and includes BOTH role body and card prompt
  const combined = readFileSync(req.promptPath, "utf8");
  assert.match(combined, /Do the dev work\./);
  assert.match(combined, /implement X/);
  // pending entry landed in the manifest under the sandbox state dir. STATE_DIR = YARRADEV_STATE_DIR (when
  // set, used verbatim per runner/paths.mjs); MANIFEST_FILE = join(STATE_DIR, "dispatch-manifest.jsonl").
  const manifest = readFileSync(join(dir, "dispatch-manifest.jsonl"), "utf8");
  assert.match(manifest, /"status":"pending"[^\n]*"cardId":"card-9"/);
});

test("native invoke: YARRADEV_HOME (CLAUDE_PLUGIN_ROOT unset) drives agent-file resolution end-to-end", () => {
  // Guards GH review finding on Task 4: a prior test only asserted resolveHome({YARRADEV_HOME:"/plugin"})
  // in isolation, which would pass even if dispatch.mjs never called resolveHome() at all. This proves the
  // wiring: set YARRADEV_HOME to a sandbox dir whose agents/developer.md differs from the real repo's
  // (model: sonnet + body "Do the dev work." vs. the repo's agents/developer.md, which is model: opus with
  // different body text). If dispatch.mjs ignored resolveHome() and fell back to the computed repo root
  // (or CLAUDE_PLUGIN_ROOT, which we explicitly unset here), it would pick up the REAL agents/developer.md
  // instead and these assertions would fail on model/body content, not just crash.
  const { dir, promptFile } = sandbox();
  const env = { ...process.env, YARRADEV_DISPATCH_MODE: "native", YARRADEV_STATE_DIR: dir, YARRADEV_HOME: dir };
  delete env.CLAUDE_PLUGIN_ROOT;
  const r = spawnSync(process.execPath, [DISPATCH, "developer", "card-home", promptFile], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const req = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(req.model, "sonnet", "resolved <YARRADEV_HOME>/agents/developer.md, not the repo's (model: opus)");
  const combined = readFileSync(req.promptPath, "utf8");
  assert.match(combined, /Do the dev work\./, "role body came from the sandbox agents/developer.md under YARRADEV_HOME");
});

test("native invoke: board.json roles override model/worktree/subagentType in the emitted request", () => {
  const { dir, promptFile } = sandbox();
  // agents/developer.md ships model:sonnet, developer is a WORKTREE_ROLES member (worktree default true).
  // Override: model→opus, worktree→false, subagentType→Explore in a project .yarradev/board.json.
  const cwd = join(dir, "proj");
  mkdirSync(join(cwd, ".yarradev"), { recursive: true });
  writeFileSync(join(cwd, ".yarradev", "board.json"),
    JSON.stringify({ roles: { developer: { model: "opus", worktree: false, subagentType: "Explore" } } }));
  const r = spawnSync(process.execPath, [DISPATCH, "developer", "card-ov", promptFile], {
    encoding: "utf8", cwd,
    env: { ...process.env, YARRADEV_DISPATCH_MODE: "native", YARRADEV_STATE_DIR: dir, CLAUDE_PLUGIN_ROOT: dir },
  });
  assert.equal(r.status, 0, r.stderr);
  const req = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(req.model, "opus", "model overridden");
  assert.equal(req.worktreeFlag, "", "worktree:false suppresses the flag");
  assert.equal(req.subagentType, "Explore", "subagentType overridden");
});

test("native invoke: absent roles block → agents/*.md model + WORKTREE_ROLES defaults", () => {
  const { dir, promptFile } = sandbox();
  const cwd = join(dir, "proj-default");
  mkdirSync(cwd, { recursive: true });
  const r = spawnSync(process.execPath, [DISPATCH, "developer", "card-def", promptFile], {
    encoding: "utf8", cwd,
    env: { ...process.env, YARRADEV_DISPATCH_MODE: "native", YARRADEV_STATE_DIR: dir, CLAUDE_PLUGIN_ROOT: dir },
  });
  assert.equal(r.status, 0, r.stderr);
  const req = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(req.model, "sonnet", "falls back to agents/developer.md");
  assert.equal(req.worktreeFlag, "--worktree yarradev-card-def", "WORKTREE_ROLES default");
  assert.equal(req.subagentType, "general-purpose", "write-role default");
});

test("--complete: writes the verdict file and appends a done manifest entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "yd-complete-"));
  const verdictPath = join(dir, "verdict.txt");
  const r = spawnSync(process.execPath, [DISPATCH, "--complete", verdictPath, "card-3", "--gen", "5", "--role", "tester"], {
    encoding: "utf8",
    input: "```json\n{\"status\":\"advance\",\"to\":\"done\"}\n```\n",
    env: { ...process.env, YARRADEV_STATE_DIR: dir },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(verdictPath, "utf8"), /"status":"advance"/);
  const manifest = readFileSync(join(dir, "dispatch-manifest.jsonl"), "utf8");
  assert.match(manifest, /"status":"done"[^\n]*"cardId":"card-3"[^\n]*"gen":"5"/);
});
