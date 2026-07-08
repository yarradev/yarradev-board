/*
 * dispatch-native.test.mjs — GH #51: native dispatch mode emits a dispatch-request for the host
 * conductor to fulfill via its Agent tool, instead of spawning an external `claude -p`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
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
  });
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
      XDG_DATA_HOME: dir,
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
  // pending entry landed in the manifest under the sandbox state dir. STATE_DIR = XDG_DATA_HOME (when set,
  // used verbatim — no "claude-bg" subdir appended); MANIFEST_FILE = join(STATE_DIR, "dispatch-manifest.jsonl").
  const manifest = readFileSync(join(dir, "dispatch-manifest.jsonl"), "utf8");
  assert.match(manifest, /"status":"pending"[^\n]*"cardId":"card-9"/);
});
