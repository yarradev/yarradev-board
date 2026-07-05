#!/usr/bin/env node
/*
 * raise-bugs-from-review.mjs — Phase B / B3.5 (auto-raised-bug-cards §6): the standalone bridge that
 * lets an out-of-lifecycle `/code-review` (e.g. run on a laptop, outside the loop) feed its CONFIRMED
 * findings into a board WITHOUT ever creating a card itself — it posts exactly ONE ADVICE act carrying
 * `data.spawn`; the board's ADVICE fold (B3) persists it to derived_json.pending_spawn, and the
 * conductor's reconcile pass (reconcile-spawn.mjs, B4) is the only thing that ever mints the bug cards.
 * The bridge's bearer is a `write:advice`-only delegate (POST /boards/:do/enable-review-bridge, B1) —
 * it is DENIED CREATE/MOVE/RELEASE at the API's PEP scope gate even if it tried.
 *
 * Usage:
 *   raise-bugs-from-review <boardApiBase> <doName> <cardId-or-PR> <findings.json>
 *     [--repo <owner/repo>] [--head <sha>] [--reason <text>]
 *
 * <cardId-or-PR>   a literal card id, OR a bare/#-prefixed PR number (e.g. "42" or "#42") — a PR number
 *                  is resolved to its linked card via GET /boards/:do/pr-link (B2); a miss (or no PR
 *                  match at all) falls back to the well-known "review-intake" card id (never invented).
 * <findings.json>  a JSON array of CONFIRMED findings: {title, file, summary, note?, repo?, status?}.
 *                  An entry with a `status` field is kept ONLY if status is "CONFIRMED"
 *                  (case-insensitive) — defense in depth; entries with no `status` field are assumed
 *                  already filtered upstream, per the documented contract. Malformed entries (missing
 *                  title/file/summary, or no resolvable repo) are dropped, never fatal.
 * --repo           the reviewed repo (owner/name). REQUIRED when <cardId-or-PR> is a PR number (B2
 *                  needs it to resolve the card) and used as the default `repo` stamped onto every
 *                  finding that doesn't carry its own `repo` field (PendingBugSpawn.repo is REQUIRED —
 *                  see packages/shared/src/types.ts on the platform side; the reconcile pass has no
 *                  "this pass's context" to source it from, unlike the in-lifecycle A7 branch).
 * --head           the reviewed commit sha, folded into the ADVICE act's `reviewed_head` (optional —
 *                  the board tolerates a null head on this non-lifecycle path).
 * --reason         optional human-readable summary; defaults to "<n> CONFIRMED finding(s)".
 *
 * Auth: the bearer comes ONLY from YDB_REVIEW_BRIDGE_TOKEN (env) — never argv, never a config file, so
 * it never lands in shell history or a checked-in file. Mint one via a human-owner session:
 * POST /boards/:do/enable-review-bridge.
 *
 * Prints { ok, status, outcome, cardId, spawnCount, dropped } and exits 0 on committed, 1 otherwise, 2
 * on a usage error.
 */
import { readFileSync } from "node:fs";
import { makeClient, emit } from "./plugin-io.mjs";

export const REVIEW_INTAKE_CARD_ID = "review-intake";

/** True unless the finding explicitly carries a non-CONFIRMED status (defense in depth). */
function isConfirmed(finding) {
  if (finding.status == null) return true;
  return String(finding.status).trim().toUpperCase() === "CONFIRMED";
}

/**
 * Map CONFIRMED findings to the raw spawn[] shape the board's ADVICE fold accepts
 * ({title,file,summary,repo,note?}) — the board/loop computes fingerprints, never this script (an
 * out-of-lifecycle poster is no more able to hand-roll a stable sha256 than an LLM reviewer is, and
 * doing so here would silently diverge from the conductor's fingerprint.mjs if the two ever drifted).
 * Malformed entries (missing title/file/summary, or no resolvable repo) are dropped, not fatal.
 *
 * @param {unknown[]} findings
 * @param {string|undefined} defaultRepo used when a finding carries no `repo` of its own
 * @returns {{ spawn: Array<{title:string,file:string,summary:string,repo:string,note?:string}>, dropped: number }}
 */
export function buildSpawn(findings, defaultRepo) {
  const spawn = [];
  let dropped = 0;
  for (const raw of findings) {
    if (raw == null || typeof raw !== "object") {
      dropped += 1;
      continue;
    }
    const f = raw;
    if (!isConfirmed(f)) {
      dropped += 1;
      continue;
    }
    const title = typeof f.title === "string" ? f.title.trim() : "";
    const file = typeof f.file === "string" ? f.file.trim() : "";
    const summary = typeof f.summary === "string" ? f.summary.trim() : "";
    const repo = (typeof f.repo === "string" && f.repo.trim()) || defaultRepo || "";
    if (!title || !file || !summary || !repo) {
      dropped += 1;
      continue;
    }
    const note = typeof f.note === "string" && f.note.trim() ? f.note : undefined;
    spawn.push(note !== undefined ? { title, file, summary, repo, note } : { title, file, summary, repo });
  }
  return { spawn, dropped };
}

/**
 * Resolve <cardId-or-PR> to a literal card id. A bare/#-prefixed integer is treated as a PR number and
 * resolved via `resolvePrLink` (GET /boards/:do/pr-link, B2); anything else is returned as-is (a literal
 * card id). A PR-number input REQUIRES `repo` (thrown as a usage error, exit 2 at the CLI layer) and
 * falls back to REVIEW_INTAKE_CARD_ID on a miss — the bridge never invents a card of its own.
 *
 * @param {string} cardIdOrPr
 * @param {string|undefined} repo
 * @param {(repo:string, prNumber:number) => Promise<string|null>} resolvePrLink
 * @returns {Promise<string>}
 */
export async function resolveCardId(cardIdOrPr, repo, resolvePrLink) {
  const trimmed = String(cardIdOrPr).trim().replace(/^#/, "");
  if (!/^\d+$/.test(trimmed)) return cardIdOrPr; // a literal card id — nothing to resolve
  if (!repo) throw new Error("cardId-or-PR is a PR number — --repo <owner/repo> is required to resolve it");
  const itemId = await resolvePrLink(repo, Number(trimmed));
  return itemId || REVIEW_INTAKE_CARD_ID;
}

/**
 * The bridge's core orchestration — resolve the card, build spawn[], post ONE ADVICE act. Testable with
 * a fake client/resolvePrLink (no network), mirroring the other CLI scripts' unit-test harness.
 *
 * @param {{ act:(a:object)=>Promise<any> }} client
 * @param {(repo:string, prNumber:number) => Promise<string|null>} resolvePrLink
 * @param {{ cardIdOrPr:string, repo?:string, head?:string, reason?:string, findings:unknown[] }} opts
 * @returns {Promise<{ cardId:string, spawnCount:number, dropped:number, result:any }>}
 */
export async function runRaiseBugsFromReview(client, resolvePrLink, opts) {
  const cardId = await resolveCardId(opts.cardIdOrPr, opts.repo, resolvePrLink);
  const { spawn, dropped } = buildSpawn(opts.findings, opts.repo);
  const reason = opts.reason ?? `${spawn.length} CONFIRMED finding(s)`;
  const result = await client.act({
    type: "ADVICE",
    item_id: cardId,
    data: { reviewed_head: opts.head ?? null, reason, spawn },
  });
  return { cardId, spawnCount: spawn.length, dropped, result };
}

// CLI: only execute when invoked directly, NOT on import — the unit test imports the exported pure
// functions above with a fake client/resolvePrLink and must not perform any real network I/O.
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const positional = [];
  const flags = { repo: undefined, head: undefined, reason: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") flags.repo = argv[++i];
    else if (a === "--head") flags.head = argv[++i];
    else if (a === "--reason") flags.reason = argv[++i];
    else positional.push(a);
  }
  const [apiBase, doName, cardIdOrPr, findingsPath] = positional;
  if (!apiBase || !doName || !cardIdOrPr || !findingsPath) {
    console.error(
      "usage: raise-bugs-from-review.mjs <boardApiBase> <doName> <cardId-or-PR> <findings.json> [--repo <owner/repo>] [--head <sha>] [--reason <text>]",
    );
    process.exit(2);
  }
  const token = process.env.YDB_REVIEW_BRIDGE_TOKEN;
  if (!token) {
    console.error(
      "YDB_REVIEW_BRIDGE_TOKEN is not set (the write:advice bearer minted by POST /boards/:do/enable-review-bridge)",
    );
    process.exit(2);
  }
  let findings;
  try {
    findings = JSON.parse(readFileSync(findingsPath, "utf8"));
  } catch (e) {
    console.error(`could not read/parse ${findingsPath}: ${e.message}`);
    process.exit(2);
  }
  if (!Array.isArray(findings)) {
    console.error(`${findingsPath} must contain a JSON array of findings`);
    process.exit(2);
  }

  const client = makeClient({ apiBase, doName, token, role: "code-reviewer" });
  const resolvePrLink = async (repo, prNumber) => {
    const url = `${apiBase}/boards/${encodeURIComponent(doName)}/pr-link?repo=${encodeURIComponent(repo)}&pr_number=${prNumber}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    return body && typeof body.item_id === "string" ? body.item_id : null;
  };

  let out;
  try {
    out = await runRaiseBugsFromReview(client, resolvePrLink, {
      cardIdOrPr,
      repo: flags.repo,
      head: flags.head,
      reason: flags.reason,
      findings,
    });
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  process.exit(emit(out.result, { cardId: out.cardId, spawnCount: out.spawnCount, dropped: out.dropped }));
}
