#!/usr/bin/env node
/*
 * push.mjs <id> <gen> <repo> <pr_number> <head> — PUSH (gen-required): re-point an EXISTING pr_link's
 * head after a re-spawn-to-fix pushed new commits, and update item.linked_head_sha.
 * Call ONLY when decide() said "respawn" (the pr_link row already exists). On a first submission use
 * link-pr.mjs instead — PUSH without a prior pr_link row strands CI (no row for facts to match).
 * <head> MUST be the full 40-char SHA. Prints { ok, status, outcome }. Exit 0 on committed, 1 otherwise.
 */
import { makeClient, emit } from "./plugin-io.mjs";

const [id, gen, repo, pr, head] = process.argv.slice(2);
if (!id || gen === undefined || !repo || !pr || !head) {
  console.error("usage: push.mjs <id> <gen> <repo> <pr_number> <head>");
  process.exit(2);
}
const r = await makeClient({ role: "developer" }).push(id, Number(gen), { repo, pr_number: Number(pr), head });
process.exit(emit(r, { blocked_by: r?.blocked_by }));
