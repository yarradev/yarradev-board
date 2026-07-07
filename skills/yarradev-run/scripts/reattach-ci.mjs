#!/usr/bin/env node
/*
 * reattach-ci.mjs <id> <repo> <pr_number> <head> — recover CI facts stranded by the CI-before-LINK_PR
 * ordering race (GH #21).
 *
 * WHY THIS EXISTS — CI check_run webhooks for a freshly-pushed PR head frequently complete BEFORE the
 * conductor posts LINK_PR (which creates the pr_link row). With no pr_link yet, the board's ingestFact
 * matches neither head nor PR and DROPS the fact. GitHub does not redeliver completed check_run events,
 * so the signal is stranded permanently → ci_rollup stays "absent" → ci_green never true → card stalls at
 * dev. (The board's matchByPr fallback only helps when a pr_link exists with a stale head, not when no
 * link exists yet.)
 *
 * THE CLIENT-SIDE LEVER — the conductor cannot post CI facts to the board (ingestFact is an HMAC-verified
 * internal path), but it CAN re-trigger the CI workflow run for the head AFTER the pr_link exists. The new
 * run emits a fresh check_run completion event, which now finds the pr_link and lands. This is exactly the
 * manual recovery shown in #21's evidence ("re-triggered the workflow runs → ci_rollup flipped").
 *
 * Best-effort, never fatal: any gh/board failure is logged to stderr and exits 0 (the conductor continues;
 * the card simply stays on its normal CI-wait path). Exits 2 only on usage error.
 *
 * Args mirror link-pr.mjs/push.mjs (`<id> <repo> <pr_number> <head>`) so the conductor calls it inline
 * right after the LINK_PR/PUSH that established the pr_link.
 */
import { makeClient } from "./plugin-io.mjs";
import { spawnSync } from "node:child_process";

/**
 * Does `gh pr checks` output contain at least one COMPLETED check (terminal bucket pass/fail), i.e. a
 * check whose completion webhook the board may have missed? Pure for unit testing (GH #21).
 * @param {{bucket?: string, state?: string}[]|null|undefined} checks from `gh pr checks --json bucket,state`
 * @returns {boolean}
 */
export function hasCompletedCheck(checks) {
  return Array.isArray(checks) && checks.some((c) => c?.bucket === "pass" || c?.bucket === "fail");
}

/**
 * Decide + execute the recovery. All side-effecting deps are injected so the decision logic is unit-
 * testable without gh or a live board.
 *
 * @param {{ getCard: (id:string)=>Promise<{ci_rollup?:string}>, ghJson: (args:string[], jq?:string)=>any, ghRun: (args:string[])=>void }} deps
 * @param {{ id: string, repo: string, pr: string, head: string }} args
 * @returns {Promise<{action: "noop"|"retriggered", reason?: string, runId?: string}>}
 */
export async function runReattachCi({ getCard, ghJson, ghRun }, { id, repo, pr, head }) {
  // 1. If CI already landed on the board, nothing to recover (don't waste a rerun).
  const card = await getCard(id);
  if (card?.ci_rollup && card.ci_rollup !== "absent") {
    return { action: "noop", reason: "ci_already_landed" };
  }
  // 2. Are there COMPLETED checks on GitHub for this head? If none (still pending / not started), the
  //    completion webhook will fire normally once CI finishes — against the now-existing pr_link — so no
  //    recovery is needed.
  const checks = ghJson(["pr", "checks", pr, "--repo", repo, "--json", "bucket,state"]);
  if (!hasCompletedCheck(checks)) {
    return { action: "noop", reason: "ci_not_completed_yet" };
  }
  // 3. Stranded: completed checks exist but the board shows absent → re-trigger the workflow run for this
  //    exact head so a fresh completion webhook re-fires against the pr_link.
  const runId = ghJson(["run", "list", "--commit", head, "--repo", repo, "--json", "databaseId"], ".[0].databaseId");
  if (!runId) {
    return { action: "noop", reason: "no_workflow_run_for_head" };
  }
  ghRun(["run", "rerun", String(runId), "--repo", repo]);
  return { action: "retriggered", runId: String(runId) };
}

// gh wrapper helpers — best-effort: a failure returns null/[]/no-op + a stderr line, never throws.
function ghJsonSync(args, jq) {
  const full = jq ? [...args, "-q", jq] : args;
  const r = spawnSync("gh", full, { encoding: "utf8" });
  if (r.status !== 0) {
    process.stderr.write(`[reattach-ci] gh ${args.join(" ")} exited ${r.status}${r.stderr ? ` — ${r.stderr.trim()}` : ""}\n`);
    return jq ? null : [];
  }
  if (jq) return r.stdout.trim() ? r.stdout.trim() : null; // -q already selected a scalar/path
  try {
    return r.stdout.trim() ? JSON.parse(r.stdout) : [];
  } catch {
    return [];
  }
}
function ghRunSync(args) {
  const r = spawnSync("gh", args, { encoding: "utf8" });
  if (r.status !== 0) {
    process.stderr.write(`[reattach-ci] gh ${args.join(" ")} exited ${r.status}${r.stderr ? ` — ${r.stderr.trim()}` : ""}\n`);
  }
}

// CLI: only execute when invoked directly — the unit test imports the helpers above and must not run gh.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [id, repo, pr, head] = process.argv.slice(2);
  if (!id || !repo || !pr || !head) {
    console.error("usage: reattach-ci.mjs <id> <repo> <pr_number> <head>");
    process.exit(2);
  }
  const client = makeClient({ role: "orchestrator" });
  const res = await runReattachCi(
    { getCard: (cid) => client.getEnriched(cid), ghJson: ghJsonSync, ghRun: ghRunSync },
    { id, repo, pr, head },
  );
  process.stdout.write(JSON.stringify(res) + "\n");
  process.exit(0); // always 0 — best-effort recovery, never fatal
}
