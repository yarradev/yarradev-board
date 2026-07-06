#!/usr/bin/env node
/*
 * dispatch-and-wait.mjs <role> <cardId> <promptFile>
 *
 * Synchronous wrapper around the async `~/work/tools/yarradev-dispatch` tool (GH #19).
 *
 * The tool is fire-and-forget BY DESIGN: it backgrounds `claude -p`, returns IMMEDIATELY with the verdict
 * file path on stdout (exit 0 = "backgrounded", NOT "finished"), and signals completion later by appending
 * a {"status":"done", verdictPath, cardId, role, ...} line to the dispatch manifest
 * (~/.local/share/claude-bg/dispatch-manifest.jsonl) once `claude -p` exits. SKILL.md's dispatch contract
 * is `V=$(dispatch-and-wait ...)` then `cat $V` — without this wrapper that reads an EMPTY file (the
 * subagent is still running), the conductor treats "no JSON block" as a dispatch failure, CLEAR_LEASEs,
 * and either retries (spawning duplicate concurrent subagents) or parks a card that is still mid-run.
 *
 * This wrapper makes the documented contract truthful: it dispatches, then BLOCKS until the matching
 * `done` entry appears in the manifest (the subagent finished), then prints the verdict file path. `cat $V`
 * then reads the now-complete verdict and parses the last fenced JSON block as before.
 *
 * Exit codes: 0 = verdict ready (path on stdout, same contract as the wrapped tool); 1 = dispatch failed
 * (tool non-zero exit / no path) OR poll timeout (the subagent outlasted YARRADEV_DISPATCH_TIMEOUT_S —
 * CLEAR_LEASE and let the next pass re-dispatch; the gen fence bounds correctness); 2 = usage.
 *
 * The wrapped tool path defaults to ~/work/tools/yarradev-dispatch (override via $YARRADEV_DISPATCH). The
 * manifest/state dir honors $XDG_DATA_HOME, identical to the tool's own resolution, so the `done` entry
 * this polls for is the same one the tool's background run.sh appends.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_S = 1800; // matches the default claimTtlS — a subagent outlasting the lease is a re-dispatch signal

/**
 * Does the manifest already contain a `done` entry for this verdictPath? Pure over the manifest CONTENT so
 * it is unit-testable without spawning the tool or touching the filesystem (GH #19).
 * @param {string} manifestContent raw JSONL (may be "" / missing)
 * @param {string} verdictPath the path the tool returned on stdout — the pending/done correlation key
 * @returns {boolean}
 */
export function manifestHasDone(manifestContent, verdictPath) {
  if (!manifestContent) return false;
  for (const line of manifestContent.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try {
      e = JSON.parse(t);
    } catch {
      continue; // malformed/partial line — skip, never crash reconciliation on a bad append
    }
    if (e && e.status === "done" && e.verdictPath === verdictPath) return true;
  }
  return false;
}

// CLI: only execute when invoked directly (`node dispatch-and-wait.mjs <role> <cardId> <promptFile>`), NOT
// on import — the unit test imports manifestHasDone and must not trigger a real dispatch.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [role, cardId, promptFile] = process.argv.slice(2);
  if (!role || !cardId || !promptFile) {
    console.error("usage: dispatch-and-wait.mjs <role> <cardId> <promptFile>");
    process.exit(2);
  }

  const tool = process.env.YARRADEV_DISPATCH ?? join(homedir(), "work", "tools", "yarradev-dispatch");
  const stateDir = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share", "claude-bg");
  const manifestPath = join(stateDir, "dispatch-manifest.jsonl");
  const timeoutS = Number(process.env.YARRADEV_DISPATCH_TIMEOUT_S ?? DEFAULT_TIMEOUT_S);

  // 1. Dispatch (async) — capture the verdict file path the tool prints on stdout. Non-zero / null status =
  //    true dispatch failure (tool missing, tmux+background both unavailable, prompt file unreadable).
  const dispatched = spawnSync(tool, [role, cardId, promptFile], { encoding: "utf8" });
  if (dispatched.status !== 0) {
    console.error(`dispatch-and-wait: yarradev-dispatch exited ${dispatched.status}${dispatched.stderr ? ` — ${dispatched.stderr.trim()}` : ""}`);
    process.exit(1);
  }
  const verdictPath = dispatched.stdout.trim();
  if (!verdictPath) {
    console.error("dispatch-and-wait: yarradev-dispatch printed no verdict path on stdout");
    process.exit(1);
  }

  // 2. Block until the matching `done` entry lands in the manifest (subagent finished) or the timeout fires.
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    const content = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : "";
    if (manifestHasDone(content, verdictPath)) {
      // 3. Verdict ready — print the path (identical stdout contract to the wrapped tool); `cat $V` reads it.
      process.stdout.write(verdictPath + "\n");
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.error(`dispatch-and-wait: timed out after ${timeoutS}s waiting for verdict (${verdictPath})`);
  process.exit(1);
}
