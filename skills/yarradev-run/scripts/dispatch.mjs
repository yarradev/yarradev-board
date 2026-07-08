#!/usr/bin/env node
/*
 * dispatch.mjs <role> <cardId> <promptFile> [--gen <gen>]
 *
 * Zero-dependency Node ESM port of ~/work/tools/yarradev-dispatch (GH #43). Spawns a `claude -p` subagent
 * as a background process, captures its verdict asynchronously to a file, and returns IMMEDIATELY with
 * that file's path on stdout. Completion is signaled later via a `done` entry appended to the shared
 * dispatch manifest — pass.mjs's reconcile reconciles verdicts on a subsequent pass (no blocking).
 *
 * Two modes in one file (discriminated by `--run`):
 *
 *   1. INVOKER (default) — mirrors the bash tool's `main`: resolves the agent file, parses frontmatter,
 *      builds the combined prompt, mints the verdict path, appends a `pending` manifest entry, then
 *      fire-and-forgets the RUNNER (detached spawn + unref, or `tmux new-window -d` when inside tmux).
 *      Prints the verdictPath on stdout, exit 0.
 *
 *   2. RUNNER (`--run ...`) — the detached background process (mirrors run.sh): spawns `claude -p` with
 *      --model/--effort/--allowedTools/<worktreeFlag>/--add-dir, stdin = combined prompt, stdout+stderr →
 *      verdict file. Retries gateway 529/overload with backoff (MAX_ATTEMPTS=4, 20→40→80s); on final
 *      failure appends a bare error-envelope line (gateway_529|crash|empty). Cleans up the worktree at
 *      COMPLETION (not dispatch time — the old bug). Appends the `done` manifest entry.
 *
 * WHY THIS REPLACES THE BASH TOOL — the bash tool is Unix/tmux-only and lives outside the repo; porting
 * it here makes the dispatcher portable (any Node) and owned/tested by the plugin. pass.mjs's
 * `makeDispatch` now defaults to this script (override via YARRADEV_DISPATCH for the legacy bash tool).
 *
 * Zero deps (Node built-ins only). ESM. No top-level execution on import (CLI body guarded by
 * import.meta.url, same pattern as note.mjs / dispatch-and-wait.mjs / reattach-ci.mjs).
 *
 * Output (stdout): path to verdict file. Exit: 0=dispatched, 1=error, 2=usage.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);

// === Constants — preserved verbatim from the bash tool (source of truth) ===
const STATE_DIR = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share", "claude-bg");
const MANIFEST_FILE = join(STATE_DIR, "dispatch-manifest.jsonl");
const TMP_BASE = join(STATE_DIR, "dispatch");

// Retry constants (env-overridable for tests). Bash: MAX_ATTEMPTS=4, BACKOFF=20 (seconds, doubled).
const MAX_ATTEMPTS = Number(process.env.YARRADEV_DISPATCH_MAX_ATTEMPTS ?? 4);
const BACKOFF_SCHEDULE_MS = (process.env.YARRADEV_DISPATCH_BACKOFF_MS ?? "20000,40000,80000")
  .split(",")
  .map((s) => Number(s.trim()) * 1);

// #51: dispatch mode. "external" (default) spawns claude -p; "native" emits a dispatch-request for the host
// conductor to fulfill via its Agent tool (status-line-visible, in-session). Env-overridable for tests.
const DISPATCH_MODE = process.env.YARRADEV_DISPATCH_MODE ?? "external";

// 529 detection. NOTE the two patterns differ between stages (preserved from bash):
//  - retry gate: `529|overloaded|temporarily overloaded`
//  - final classification: `529|overloaded`
const RETRY_529_RE = /529|overloaded|temporarily overloaded/i;
const CLASSIFY_529_RE = /529|overloaded/i;

// #42: roles that mutate the repo get a worktree; read-only advisors do NOT.
const WORKTREE_ROLES = new Set(["developer", "releaser", "tester", "devops"]);

// ============================================================================
// Pure helpers — exported for unit testing (no I/O)
// ============================================================================

/**
 * Extract a frontmatter field's value from agent markdown, mirroring the bash sed pattern that finds
 * the first `^<key>:` line and strips everything up to (and including) the colon plus its trailing
 * whitespace. Returns the FIRST such match. Empty string if absent.
 * @param {string} content
 * @param {string} key e.g. "model"
 * @returns {string}
 */
export function extractField(content, key) {
  const prefix = key + ":";
  for (const line of content.split("\n")) {
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length).replace(/^[ \t\r]*/, "");
    }
  }
  return "";
}

/**
 * Parse an agent .md file into frontmatter + body. Mirrors the bash:
 *   MODEL=$(sed -n '/^model:/...'); EFFORT=...; TOOLS=...; SYSPROMPT=$(awk 'c>=2')
 * with the same defaults: model=sonnet, effort=low, tools="Read, Bash".
 * Body = everything after the second `^---$` line (the agent system prompt).
 * @param {string} content raw agent file text
 * @returns {{model:string, effort:string, tools:string, body:string}}
 */
export function parseFrontmatter(content) {
  const model = extractField(content, "model") || "sonnet";
  const effort = extractField(content, "effort") || "low";
  const tools = extractField(content, "tools") || "Read, Bash";
  const body = extractBody(content);
  return { model, effort, tools, body };
}

/**
 * Extract the agent body (everything after the second `---` fence). Mirrors the bash awk
 * `BEGIN{c=0} /^---$/{c++; next} c>=2{print}`. A line matches the fence iff it is exactly `---`.
 * @param {string} content
 * @returns {string}
 */
export function extractBody(content) {
  let c = 0;
  const out = [];
  for (const line of content.split("\n")) {
    if (line === "---") {
      c++;
      continue;
    }
    if (c >= 2) out.push(line);
  }
  return out.join("\n");
}

/**
 * Build the combined prompt: role instructions prepended to the card-context prompt. Mirrors the bash
 * `=== Role instructions === / <body> / "" / === Card context === / <cardPrompt>` layout exactly
 * (echo adds \n after each line; cat emits the file verbatim with no added trailing newline).
 * @param {string} roleBody the agent body (system prompt)
 * @param {string} cardPrompt the card-context prompt file content
 * @returns {string}
 */
export function buildCombinedPrompt(roleBody, cardPrompt) {
  return (
    "=== Role instructions (append to your system prompt) ===\n" +
    roleBody +
    "\n\n" +
    "=== Card context ===\n" +
    cardPrompt
  );
}

/**
 * Decide the `--worktree yarradev-<cardId>` flag for a role. The #42 set (developer/releaser/tester/
 * devops) runs in an isolated worktree; read-only advisors (designer/analyst/code-reviewer/...) do NOT.
 * @param {string} role
 * @param {string} cardId
 * @returns {string} the flag string, or "" for read-only roles
 */
export function worktreeFlagFor(role, cardId) {
  return WORKTREE_ROLES.has(role) ? `--worktree yarradev-${cardId}` : "";
}

/**
 * Should the verdict trigger a 529 retry? Case-insensitive match for `529|overloaded|temporarily
 * overloaded` (the retry gate; broader than the classify pattern — preserved from bash).
 * @param {string} text
 * @returns {boolean}
 */
export function is529Retryable(text) {
  return RETRY_529_RE.test(text ?? "");
}

/**
 * Classify a failed verdict into an error_type for the bare envelope. Mirrors the bash final block:
 *   529|overloaded in verdict → gateway_529; empty verdict → empty; otherwise → crash.
 * Uses the NARROWER classify pattern (no "temporarily overloaded" — preserved from bash).
 * @param {string} verdictText
 * @returns {"gateway_529"|"crash"|"empty"}
 */
export function classifyError(verdictText) {
  const t = verdictText ?? "";
  if (CLASSIFY_529_RE.test(t)) return "gateway_529";
  if (t.length === 0) return "empty";
  return "crash";
}

/**
 * Build the diagnostic `detail` for the error envelope: last 3 lines of the verdict joined with spaces,
 * truncated to 240 chars (mirrors `tail -3 | tr '\n' ' ' | cut -c1-240`). Quote/backslash escaping is
 * left to JSON.stringify (the bash's manual `s/"/\\"/g` produces equivalent valid JSON).
 * @param {string} verdictText
 * @returns {string} <=240 chars
 */
export function buildDetail(verdictText) {
  const lines = (verdictText ?? "").split("\n");
  const tail = lines.slice(-3).join(" ");
  return tail.slice(0, 240);
}

/**
 * Build the bare error-envelope JSON line appended on final failure (what pass.mjs's
 * parseErrorEnvelope reads — GH #44). Shape: `{"status":"error","error_type":...,"detail":...}`.
 * @param {string} verdictText
 * @returns {string} a single JSON line (no trailing newline)
 */
export function buildErrorEnvelope(verdictText) {
  return JSON.stringify({
    status: "error",
    error_type: classifyError(verdictText),
    detail: buildDetail(verdictText),
  });
}

/**
 * Build the `pending` manifest entry line. Shape preserved verbatim from the bash tool.
 * @param {{cardId:string, verdictPath:string, gen:string, role:string, dispatchedAt:string}} e
 * @returns {string} single JSON line (no trailing newline)
 */
export function pendingEntry({ cardId, verdictPath, gen, role, dispatchedAt }) {
  return JSON.stringify({ status: "pending", cardId, verdictPath, gen, role, dispatchedAt });
}

/**
 * Build the `done` manifest entry line. Shape preserved verbatim from the bash tool.
 * @param {{cardId:string, verdictPath:string, gen:string, role:string, completedAt:string}} e
 * @returns {string} single JSON line (no trailing newline)
 */
export function doneEntry({ cardId, verdictPath, gen, role, completedAt }) {
  return JSON.stringify({ status: "done", cardId, verdictPath, gen, role, completedAt });
}

/**
 * Build the native-mode dispatch-request the host conductor fulfills via its Agent tool (GH #51). Pure.
 * `promptPath` is the COMBINED prompt (role instructions + card prompt), so the conductor can pass it
 * straight to the Agent tool. Shape is the contract SKILL.md's native protocol reads.
 * @returns {{action:"dispatch-request", role, cardId, verdictPath, gen, promptPath, model, effort, tools, worktreeFlag}}
 */
export function buildDispatchRequest({ role, cardId, verdictPath, gen, promptPath, model, effort, tools, worktreeFlag }) {
  return { action: "dispatch-request", role, cardId, verdictPath, gen, promptPath, model, effort, tools, worktreeFlag };
}

/**
 * ISO-8601 UTC timestamp (`date -u +%Y-%m-%dT%H:%M:%SZ` equivalent). Trims to whole seconds.
 * @returns {string}
 */
export function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Native completion (GH #51): the host conductor calls this after its Agent-tool subagent returns, piping the
 * agent's final message (the verdict) on stdin. Writes the verdict file and appends the `done` manifest entry —
 * the exact artifacts `pass.mjs`'s reconcile consumes, so external and native land identically.
 * @param {{verdictText:string, verdictPath:string, cardId:string, gen:string, role:string, manifestPath:string}} o
 */
export function completeNative({ verdictText, verdictPath, cardId, gen, role, manifestPath }) {
  mkdirSync(dirname(verdictPath), { recursive: true });
  writeFileSync(verdictPath, verdictText);
  mkdirSync(dirname(manifestPath), { recursive: true });
  appendFileSync(manifestPath, doneEntry({ cardId, verdictPath, gen, role, completedAt: utcNow() }) + "\n");
}

/**
 * Strip YDB_TOKEN* from the env handed to a spawned runner/subagent (defense-in-depth, GH #25). The
 * runner spawns `claude -p` as the subagent — it must NOT inherit board bearer tokens (a prompt-injected
 * role could otherwise `printenv` them and forge board acts). Case-insensitive. Leaves PATH/HOME and
 * role credentials the subagent legitimately needs intact. Pure for unit testing.
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv} a sanitized copy
 */
export function sanitizeEnv(env) {
  const clean = { ...env };
  for (const k of Object.keys(clean)) {
    if (/^YDB_TOKEN/i.test(k)) delete clean[k];
  }
  return clean;
}

/**
 * Resolve the agent file path. Mirrors the bash:
 * `${CLAUDE_PLUGIN_ROOT:-$HOME/work/yarradev/yarradev-board}/agents/<role>.md`.
 * @param {string} role
 * @returns {string}
 */
export function resolveAgentFile(role) {
  const base = process.env.CLAUDE_PLUGIN_ROOT ?? join(homedir(), "work", "yarradev", "yarradev-board");
  return join(base, "agents", `${role}.md`);
}

// ============================================================================
// Runner core — exported with injected deps so the retry loop is unit-testable
// without writing a fake binary to disk (the loop calls `invokeClaude(attempt)`).
// ============================================================================

/**
 * Run the claude -p retry loop (the heart of run.sh). Pure over the injected `invokeClaude` + verdict
 * file: each attempt writes stdout+stderr to the verdict file, then the attempt marker; on a 529 it
 * sleeps (backoff) and truncates between attempts. Breaks immediately on success (rc 0) or a non-529
 * failure. Returns the final {rc, attempts}.
 *
 * @param {{
 *   invokeClaude: (attempt:number) => {rc:number, out:string},  // runs claude -p once; returns exit + stdout/stderr
 *   verdictPath: string,
 *   maxAttempts?: number,
 *   backoffScheduleMs?: number[],
 *   sleep?: (ms:number) => Promise<void>,
 *   writeFileSync: typeof import("node:fs").writeFileSync,
 *   appendFileSync: typeof import("node:fs").appendFileSync,
 *   log?: (...a:any[]) => void,
 * }} deps
 * @returns {Promise<{rc:number, attempts:number}>}
 */
export async function runRetryLoop({
  invokeClaude,
  verdictPath,
  maxAttempts = MAX_ATTEMPTS,
  backoffScheduleMs = BACKOFF_SCHEDULE_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  writeFileSync: wf = writeFileSync,
  appendFileSync: af = appendFileSync,
  log = () => {},
}) {
  let rc = 1;
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    const r = invokeClaude(attempt);
    rc = typeof r.rc === "number" ? r.rc : 1;
    const out = r.out ?? "";
    // claude stdout+stderr → verdict (overwrite, mirrors `> verdict 2>&1`), then the attempt marker.
    wf(verdictPath, out);
    af(verdictPath, `\n--- attempt ${attempt} exit: ${rc} ---\n`);
    log({ stage: "attempt", attempt, rc });
    if (rc === 0) break;
    // Retry ONLY on a gateway 529/overload; any other failure stops now.
    if (RETRY_529_RE.test(out) && attempt < maxAttempts) {
      const backoff = backoffScheduleMs[attempt - 1] ?? backoffScheduleMs[backoffScheduleMs.length - 1] ?? 20000;
      af(verdictPath, `\n--- retry in ${Math.round(backoff / 1000)}s (gateway 529) ---\n`);
      await sleep(backoff);
      wf(verdictPath, ""); // truncate between attempts (`: > verdict`)
      continue;
    }
    break;
  }
  return { rc, attempts };
}

/**
 * Finalize a completed runner: on failure append the bare error envelope; best-effort worktree cleanup;
 * append the `done` manifest entry. Mirrors the tail of run.sh. Best-effort throughout (never throws on
 * side-effect failure — the runner must still signal `done` so reconcile can move the card forward).
 *
 * @param {{
 *   rc: number,
 *   verdictPath: string,
 *   manifestPath: string,
 *   doneLine: string,
 *   worktreeDir?: string|null,            // if set, `git worktree remove --force` (best-effort)
 *   gitCwd?: string,                       // -C dir for the worktree remove
 *   readFileSync?: typeof import("node:fs").readFileSync,
 *   appendFileSync?: typeof import("node:fs").appendFileSync,
 *   spawnSync?: typeof import("node:child_process").spawnSync,
 * }} deps
 */
export function finalizeRunner({
  rc,
  verdictPath,
  manifestPath,
  doneLine,
  worktreeDir = null,
  gitCwd,
  readFileSync: rf = readFileSync,
  appendFileSync: af = appendFileSync,
  spawnSync: ss = spawnSync,
}) {
  // On failure append the bare error envelope (keep the raw failure text above it for diagnostics).
  if (rc !== 0) {
    try {
      const verdictText = rf(verdictPath, "utf8");
      af(verdictPath, buildErrorEnvelope(verdictText) + "\n");
    } catch {
      /* best-effort */
    }
  }
  // Worktree cleanup at COMPLETION (not dispatch time — only remove after claude -p exits).
  if (worktreeDir && gitCwd) {
    try {
      ss("git", ["-C", gitCwd, "worktree", "remove", worktreeDir, "--force"], { stdio: "ignore" });
    } catch {
      /* best-effort — ignore */
    }
  }
  // Signal completion via manifest (always — even on failure, reconcile routes the error envelope).
  try {
    af(manifestPath, doneLine + "\n");
  } catch {
    /* best-effort */
  }
}

// ============================================================================
// Binary resolution — mirrors bash `command -v claude || echo ~/.local/bin/claude` portably
// ============================================================================

/** Scan $PATH for an executable file named `name`. Returns the absolute path or undefined. */
function findOnPath(name) {
  const path = process.env.PATH ?? "";
  const sep = path.includes(";") && !path.includes(":") ? ";" : ":"; // windows-safe-ish
  for (const dir of path.split(sep)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep scanning */
    }
  }
  return undefined;
}

/**
 * Resolve the claude binary: $YARRADEV_CLAUDE_BIN override → `claude` on PATH → ~/.local/bin/claude
 * fallback. Mirrors the bash `command -v claude 2>/dev/null || echo /Users/nabsha/.local/bin/claude`
 * (the hardcoded user path generalized to ~ so it's portable).
 */
function resolveClaudeBin() {
  if (process.env.YARRADEV_CLAUDE_BIN) return process.env.YARRADEV_CLAUDE_BIN;
  return findOnPath("claude") ?? join(homedir(), ".local", "bin", "claude");
}

/** Resolve the tmux binary (best-effort; undefined if not on PATH). */
function resolveTmuxBin() {
  return process.env.YARRADEV_TMUX_BIN ?? findOnPath("tmux") ?? undefined;
}

// ============================================================================
// INVOKER (default mode — no --run)
// ============================================================================

/**
 * Dispatch a subagent: build everything, append the pending entry, fire-and-forget the runner.
 * @param {{role:string, cardId:string, promptFile:string, gen?:string}} opts
 * @returns {string} the verdict file path
 */
function invoke({ role, cardId, promptFile, gen = "" }) {
  if (!existsSync(promptFile)) {
    console.error(`dispatch.mjs: prompt file not found: ${promptFile}`);
    process.exit(1);
  }
  const agentFile = resolveAgentFile(role);
  if (!existsSync(agentFile)) {
    console.error(`dispatch.mjs: agent definition not found: ${agentFile}`);
    process.exit(1);
  }

  const agentContent = readFileSync(agentFile, "utf8");
  const { model, effort, tools, body } = parseFrontmatter(agentContent);
  const cardPrompt = readFileSync(promptFile, "utf8");
  const combinedPrompt = buildCombinedPrompt(body, cardPrompt);

  // Temp dir + verdict path under the dispatch tmp base (portable — no /tmp assumption).
  const rand = `${process.pid}-${Math.floor(Math.random() * 1e9)}`;
  const tmpDir = join(TMP_BASE, `${role}-${cardId}-${rand}`);
  mkdirSync(tmpDir, { recursive: true });
  const combinedPromptPath = join(tmpDir, "prompt.txt");
  const verdictPath = join(tmpDir, "verdict.txt");
  writeFileSync(combinedPromptPath, combinedPrompt);

  const worktreeFlag = worktreeFlagFor(role, cardId);
  const origPwd = process.cwd();
  const manifestPath = MANIFEST_FILE;
  const dispatchedAt = utcNow();

  // Record the pending dispatch BEFORE firing the runner (so a fast `done` always finds a pending).
  mkdirSync(STATE_DIR, { recursive: true });
  appendFileSync(
    manifestPath,
    pendingEntry({ cardId, verdictPath, gen, role, dispatchedAt }) + "\n",
  );

  // #51 native mode: do NOT spawn a runner. Emit the dispatch-request for the host conductor to fulfill via
  // its Agent tool; it will write the verdict + `done` entry via `dispatch.mjs --complete`. Pending is
  // already recorded above (so the in-flight filter + reconcile behave identically to external mode).
  if (DISPATCH_MODE === "native") {
    process.stdout.write(
      JSON.stringify(buildDispatchRequest({ role, cardId, verdictPath, gen, promptPath: combinedPromptPath, model, effort, tools, worktreeFlag })) + "\n",
    );
    return verdictPath;
  }

  // Runner argv (the runner derives the manifest path itself, but we pass --manifest for tests/override).
  const runnerArgs = [
    __filename,
    "--run",
    role,
    cardId,
    combinedPromptPath,
    "--gen",
    gen,
    "--verdict",
    verdictPath,
    "--model",
    model,
    "--effort",
    effort,
    "--tools",
    tools,
    "--worktree-flag",
    worktreeFlag,
    "--orig-pwd",
    origPwd,
    "--manifest",
    manifestPath,
  ];

  const env = sanitizeEnv(process.env);

  // Fire-and-forget: detached spawn + unref returns immediately. Inside tmux, additionally wrap in a
  // new-window for live observability (mirrors the bash tmux-or-background choice).
  const inTmux = Boolean(process.env.TMUX);
  const tmuxBin = resolveTmuxBin();
  if (inTmux && tmuxBin) {
    const windowName = `${role}-${cardId}`.slice(0, 50);
    try {
      spawn(
        tmuxBin,
        ["new-window", "-d", "-n", windowName, "--", process.execPath, ...runnerArgs],
        { detached: true, stdio: "ignore", env },
      ).unref();
      process.stderr.write(
        `dispatch.mjs: dispatched ${role}-${cardId} in tmux window (verdict at ${verdictPath})\n`,
      );
    } catch {
      // tmux spawn failed — fall through to the detached default.
      spawn(process.execPath, runnerArgs, { detached: true, stdio: "ignore", env }).unref();
      process.stderr.write(
        `dispatch.mjs: dispatched ${role}-${cardId} as background process (tmux spawn failed — verdict at ${verdictPath})\n`,
      );
    }
  } else {
    spawn(process.execPath, runnerArgs, { detached: true, stdio: "ignore", env }).unref();
    process.stderr.write(
      `dispatch.mjs: dispatched ${role}-${cardId} as background process${inTmux ? " (tmux binary not found)" : ""} — verdict at ${verdictPath}\n`,
    );
  }

  // The contract pass.mjs's makeDispatch reads: verdictPath on stdout.
  process.stdout.write(verdictPath + "\n");
  return verdictPath;
}

// ============================================================================
// RUNNER (--run mode — the detached background process)
// ============================================================================

/** Parse the runner's named flags (--gen/--verdict/--model/...) out of argv. */
function parseRunnerFlags(argv) {
  const out = { gen: "", worktreeFlag: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--gen": out.gen = argv[++i] ?? ""; break;
      case "--role": out.role = argv[++i] ?? ""; break;
      case "--verdict": out.verdictPath = argv[++i] ?? ""; break;
      case "--model": out.model = argv[++i] ?? "sonnet"; break;
      case "--effort": out.effort = argv[++i] ?? "low"; break;
      case "--tools": out.tools = argv[++i] ?? "Read, Bash"; break;
      case "--worktree-flag": out.worktreeFlag = argv[++i] ?? ""; break;
      case "--orig-pwd": out.origPwd = argv[++i] ?? process.cwd(); break;
      case "--manifest": out.manifestPath = argv[++i] ?? MANIFEST_FILE; break;
      default: out[a] = argv[++i]; // tolerate unknown flags (forward-compat)
    }
  }
  return out;
}

/**
 * Run the detached runner: spawn claude -p with retry, finalize the verdict, append `done`.
 * @param {{role:string, cardId:string, promptFile:string, flags:object}} opts
 */
async function runRunner({ role, cardId, promptFile, flags }) {
  const {
    gen,
    verdictPath,
    model,
    effort,
    tools,
    worktreeFlag,
    origPwd,
    manifestPath,
  } = flags;

  const promptContent = readFileSync(promptFile, "utf8");
  const claudeBin = resolveClaudeBin();

  // Build the claude argv (mirror run.sh). worktreeFlag is "" or "--worktree yarradev-<cardId>".
  const worktreeArgs = worktreeFlag ? worktreeFlag.split(/\s+/).filter(Boolean) : [];
  const claudeArgs = [
    "-p",
    "--model",
    model,
    "--effort",
    effort,
    "--allowedTools",
    tools,
    ...worktreeArgs,
    "--add-dir",
    origPwd,
  ];

  // invokeClaude: one claude -p run, stdin=combined prompt, stdout+stderr captured.
  const invokeClaude = () => {
    const r = spawnSync(claudeBin, claudeArgs, {
      input: promptContent,
      encoding: "utf8",
      env: process.env,
    });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    return { rc: typeof r.status === "number" ? r.status : 1, out };
  };

  const { rc } = await runRetryLoop({
    invokeClaude,
    verdictPath,
    maxAttempts: MAX_ATTEMPTS,
    backoffScheduleMs: BACKOFF_SCHEDULE_MS,
  });

  // Worktree dir for cleanup: <origPwd>/.claude/worktrees/yarradev-<cardId> (only if a worktree was used).
  let worktreeDir = null;
  if (worktreeFlag) {
    const match = /--worktree\s+(\S+)/.exec(worktreeFlag);
    const wtName = match ? match[1] : `yarradev-${cardId}`;
    worktreeDir = join(origPwd, ".claude", "worktrees", wtName);
  }

  finalizeRunner({
    rc,
    verdictPath,
    manifestPath,
    doneLine: doneEntry({ cardId, verdictPath, gen, role, completedAt: utcNow() }),
    worktreeDir,
    gitCwd: origPwd,
  });
}

// ============================================================================
// CLI body — only runs when invoked directly (`node dispatch.mjs ...`)
// ============================================================================

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const argv = process.argv.slice(2);

    // --- usage / help ---
    if (argv[0] === "-h" || argv[0] === "--help") {
      process.stderr.write(
        `dispatch.mjs — background subagent dispatcher for yarradev (portable port of yarradev-dispatch)

Usage: dispatch.mjs <role> <cardId> <promptFile> [--gen <gen>]
       dispatch.mjs --run <role> <cardId> <promptFile> --verdict <path> --model <m> --effort <e> --tools <t> [--gen <g>] [--worktree-flag <flag>] [--orig-pwd <dir>] [--manifest <path>]

The invoker reads agent config from $CLAUDE_PLUGIN_ROOT/agents/<role>.md and runs claude -p as a
background process with the agent's model/effort/tools. Output is captured to a verdict file.
Returns IMMEDIATELY — the caller reconciles verdicts on a subsequent pass via the shared manifest.

Exit: 0=dispatched, 1=error, 2=usage
`,
      );
      process.exit(0);
    }

    // --- runner mode (--run ...) ---
    if (argv[0] === "--run") {
      const rest = argv.slice(1);
      const positional = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i]?.startsWith("--")) break;
        positional.push(rest[i]);
      }
      const [role, cardId, promptFile] = positional;
      if (!role || !cardId || !promptFile) {
        process.stderr.write("dispatch.mjs: --run requires <role> <cardId> <promptFile>\n");
        process.exit(2);
      }
      const flags = parseRunnerFlags(rest.slice(positional.length));
      try {
        await runRunner({ role, cardId, promptFile, flags });
      } catch (e) {
        // Never crash silently — but still try to land a done entry so reconcile isn't stuck waiting.
        process.stderr.write(`dispatch.mjs runner error: ${e?.stack ?? e}\n`);
        try {
          appendFileSync(
            flags.manifestPath ?? MANIFEST_FILE,
            doneEntry({
              cardId,
              verdictPath: flags.verdictPath ?? "",
              gen: flags.gen ?? "",
              role,
              completedAt: utcNow(),
            }) + "\n",
          );
        } catch {
          /* best-effort */
        }
        process.exit(1);
      }
      process.exit(0);
    }

    // --- native completion (--complete <verdictPath> <cardId> --gen <g> --role <r>) ---
    if (argv[0] === "--complete") {
      const verdictPath = argv[1];
      const cardId = argv[2];
      if (!verdictPath || !cardId) {
        process.stderr.write("dispatch.mjs: --complete requires <verdictPath> <cardId>\n");
        process.exit(2);
      }
      const flags = parseRunnerFlags(argv.slice(3)); // reuses --gen/--role parsing
      const verdictText = readFileSync(0, "utf8"); // stdin
      completeNative({
        verdictText, verdictPath, cardId,
        gen: flags.gen ?? "", role: flags.role ?? "",
        manifestPath: MANIFEST_FILE,
      });
      process.exit(0);
    }

    // --- invoker mode (default) ---
    const [role, cardId, promptFile] = argv;
    if (!role || !cardId || !promptFile) {
      process.stderr.write("usage: dispatch.mjs <role> <cardId> <promptFile> [--gen <gen>]\n");
      process.exit(2);
    }
    // Optional --gen <n>
    let gen = "";
    const rest = argv.slice(3);
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--gen") {
        gen = rest[++i] ?? "";
      } else {
        process.stderr.write(`usage: dispatch.mjs <role> <cardId> <promptFile> [--gen <gen>]\n`);
        process.exit(2);
      }
    }
    invoke({ role, cardId, promptFile, gen });
    process.exit(0);
  })();
}
