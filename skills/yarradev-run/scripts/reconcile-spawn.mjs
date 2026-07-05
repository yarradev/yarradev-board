#!/usr/bin/env node
/*
 * reconcile-spawn.mjs — Phase B / B4 (auto-raised-bug-cards §6): drains a card's
 * `derived_json.pending_spawn` (accumulated by the board's ADVICE fold when an out-of-lifecycle
 * `/code-review` bridge posts a spawn-request ADVICE act — Phase B / B1-B3) into bug cards, mirroring
 * the in-lifecycle A7 spawn branch (SKILL.md's Advisor-verdict rule) EXACTLY: compute the deterministic
 * id via fingerprint.mjs, pre-check existence via getEnriched, CREATE if absent (--role orchestrator —
 * only the orchestrator ever creates cards), then NOTE the repro if present and not yet posted.
 *
 * Unlike the in-lifecycle branch, this runs on the loop's OWN schedule, independent of any advisor
 * dispatch — there is no "this pass's context" to source `repo` from, which is why PendingBugSpawn.repo
 * is REQUIRED (see packages/shared/src/types.ts on the platform side) and every entry here already
 * carries it.
 *
 * No bookkeeping beyond the existence pre-check (design §6 "Marking processed" — v1 relies on the
 * existence check alone): `pending_spawn` is never trimmed/cleared by this script. Idempotent: a
 * fully-filed entry (card exists, notes non-empty) is a cheap skip on every future pass.
 *
 * The cap (SPAWN_CAP_PER_CARD, default 20, mirrors reduce()'s/A7's cap) bounds MUTATIONS per pass, not
 * entries examined — an already-filed entry is a cheap read-only skip and does NOT count against the
 * cap, so older entries never permanently starve newer ones out of a fixed array prefix; entries beyond
 * the cap are simply deferred to the next pass (not dropped).
 */
import { runFingerprint } from "./fingerprint.mjs";
import { runNote } from "./note.mjs";
import { makeClient } from "./plugin-io.mjs";

export const SPAWN_CAP_PER_CARD = 20;

/**
 * Reconcile ONE card's pending_spawn entries into bug cards (idempotent — safe to re-run).
 *
 * @param {{ getEnriched:(id:string)=>Promise<any>, create:(id:string,data:object)=>Promise<any>, act:(a:object)=>Promise<any> }} client
 * @param {string} cardId the reviewed card this pending_spawn belongs to (used as parent_id)
 * @param {Array<{title:string,file:string,summary:string,repo:string,note?:string}>} pendingSpawn
 * @param {{ fingerprint?: (repo:string,file:string,summary:string)=>Promise<string>, cap?: number }} [opts]
 * @returns {Promise<{ created:string[], noted:string[], skipped:string[], deferred:number, stoppedOnError?: {id:string, step:"create"|"note"} }>}
 */
export async function reconcileCardSpawn(client, cardId, pendingSpawn, opts = {}) {
  const fingerprint = opts.fingerprint ?? runFingerprint;
  const cap = opts.cap ?? SPAWN_CAP_PER_CARD;
  const created = [];
  const noted = [];
  const skipped = [];
  let mutations = 0; // CREATE/NOTE calls actually made this pass — the cap bounds NEW work, not re-checks
  let examined = 0;

  for (const entry of pendingSpawn) {
    if (mutations >= cap) break; // cap reached — remaining entries retry next pass (deferred, not dropped)
    examined += 1;
    const id = await fingerprint(entry.repo, entry.file, entry.summary);
    const existing = await client.getEnriched(id);

    if (!existing) {
      // Absent — mint it under the ORCHESTRATOR identity (never the reviewer's), parented to the
      // reviewed card. A CREATE failure is not silently swallowed: stop this pass for this card: the
      // next pass re-observes the SAME pending_spawn (never trimmed) and retries from scratch.
      const createRes = await client.create(id, { type: "bug", title: entry.title, state: "dev", parent_id: cardId });
      mutations += 1;
      if (createRes?.outcome !== "committed") return { created, noted, skipped, deferred: pendingSpawn.length - examined, stoppedOnError: { id, step: "create" } };
      created.push(id);
      if (entry.note) {
        const noteExit = await runNote(client, id, entry.note);
        mutations += 1;
        if (noteExit !== 0) return { created, noted, skipped, deferred: pendingSpawn.length - examined, stoppedOnError: { id, step: "note" } };
        noted.push(id);
      }
      continue;
    }

    // Already exists — check whether the repro note already landed.
    if (!entry.note) {
      skipped.push(id); // nothing to attach; already filed (or filed without a repro)
      continue;
    }
    const hasNotes = Array.isArray(existing.notes) && existing.notes.length > 0;
    if (hasNotes) {
      skipped.push(id); // fully filed already
      continue;
    }
    // Card exists but the repro NOTE never landed (a prior pass's NOTE call failed/was interrupted) —
    // retry the NOTE alone; do NOT re-run CREATE.
    const noteExit = await runNote(client, id, entry.note);
    mutations += 1;
    if (noteExit !== 0) return { created, noted, skipped, deferred: pendingSpawn.length - examined, stoppedOnError: { id, step: "note" } };
    noted.push(id);
  }

  return { created, noted, skipped, deferred: pendingSpawn.length - examined };
}

// CLI: scan every card, reconcile each one's pending_spawn. Only runs on direct invocation, not import
// (the unit test imports reconcileCardSpawn with a fake client and must not drive a real board).
if (import.meta.url === `file://${process.argv[1]}`) {
  const client = makeClient({ role: "orchestrator" });
  const listed = await client.listCards();
  const items = Array.isArray(listed) ? listed : (listed?.items ?? []);
  for (const summary of items) {
    if (!summary.id) continue; // corrupt item — unactionable, mirrors list-ready.mjs
    const card = await client.getEnriched(summary.id);
    if (!card) continue; // vanished between list and read — skip, next pass re-observes
    const pendingSpawn = Array.isArray(card.pending_spawn) ? card.pending_spawn : [];
    if (pendingSpawn.length === 0) continue;
    const result = await reconcileCardSpawn(client, card.id, pendingSpawn);
    process.stdout.write(JSON.stringify({ id: card.id, ...result }) + "\n");
    if (result.stoppedOnError) {
      process.stderr.write(`reconcile-spawn: ${card.id} stopped at ${result.stoppedOnError.step} for ${result.stoppedOnError.id}\n`);
    }
  }
}
