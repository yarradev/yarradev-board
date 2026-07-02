#!/usr/bin/env node
/*
 * link-pr.mjs <id> <gen> <repo> <pr_number> <head> — LINK_PR (gen-required): bind a PR head to the card.
 * Creates the pr_link row that CI facts head-match on, and sets item.linked_head_sha.
 * Call on the FIRST submission (decide kind:"work"). Do NOT use push.mjs instead on first submission —
 * a PUSH with no prior pr_link row commits but creates no row, so CI can never match (card hangs).
 * <head> MUST be the full 40-char SHA (CI ingest matches head_sha by exact equality).
 * Prints { ok, status, outcome }. Exit 0 on committed, 1 otherwise.
 */
import { makeClient, emit } from "./plugin-io.mjs";

const [id, gen, repo, pr, head] = process.argv.slice(2);
if (!id || gen === undefined || !repo || !pr || !head) {
  console.error("usage: link-pr.mjs <id> <gen> <repo> <pr_number> <head>");
  process.exit(2);
}
const r = await makeClient({ role: "developer" }).linkPr(id, Number(gen), { repo, pr_number: Number(pr), head });
process.exit(emit(r));
