#!/usr/bin/env node
/*
 * list-ready.mjs — print one JSON line per actionable card:
 *   { "kind":"work"|"advance"|"respawn"|"reclaim"|"escalate"|"promote", "id", "state", "role"?, "to"?, "reason"?, "title" }
 * `work` carries role+to; `advance` carries role+to; `respawn` carries role; `reclaim` carries role+to
 * (an expired lease — re-dispatch the stage owner, same as work); `promote` carries to (human-gated stage);
 * `escalate` carries reason (budget exhausted / CI stalled / board-drift). `title` is the intent. The
 * generation is NOT emitted (acts use only the gen returned by CLAIM). Non-actionable cards
 * (terminal/blocked/leased/ci-pending/ci-absent/…) are logged to stderr and skipped.
 *
 * Drives from the vendored orchestrator-core: decide() is the shipped runtime engine (arg order
 * card, lifecycle, policy, nowMs — budgets are sourced internally). decide() reads EnrichedItem fields
 * (open_questions/vetoes/next_transitions), so each card is fetched via getEnriched(), not the thin
 * list projection.
 */
import { decide } from "./vendor/core.mjs";
import { makeClient, loadConfig } from "./plugin-io.mjs";

const cfg = loadConfig();
// TeamPolicy for decide(). core.decide currently sources the advisor role from lifecycle[state].advisors
// (policy is presently unused), but the signature requires a well-formed TeamPolicy — derive from cfg's
// policy if present, else an empty advisor list.
const policy = { advisors: cfg.policy?.advisors ?? [] };
const client = makeClient({ role: "orchestrator" });
const now = Date.now();

// GET /cards returns { items, nextAfterId }; the vendored core types listCards() as ItemSnapshot[] and
// returns the body verbatim, so accept either shape (array now, or a fixed array-returning core later).
const listed = await client.listCards();
const items = Array.isArray(listed) ? listed : (listed?.items ?? []);

for (const summary of items) {
  // A card with no id is corrupt (e.g. a CREATE that committed with an empty item_id): no act can
  // target it — every non-CREATE act fence-fails on the missing item — so it can never be actioned.
  // Skip it so it can't wedge the pass (it would otherwise sort first by id ASC and starve real work).
  if (!summary.id) {
    process.stderr.write(`skip <empty-id> (${summary.state}): corrupt item — unactionable\n`);
    continue;
  }
  // decide() needs the enriched view (open_questions/vetoes/next_transitions), which the list
  // projection omits. Fetch it per card; a card that vanished between list and read is simply skipped.
  const card = await client.getEnriched(summary.id);
  if (!card) {
    process.stderr.write(`skip ${summary.id} (${summary.state}): enriched fetch returned nothing\n`);
    continue;
  }
  const a = decide(card, cfg.lifecycle, policy, now);
  if (a.kind === "noop") {
    process.stderr.write(`skip ${card.id} (${card.state}): ${a.reason}\n`);
    continue;
  }
  const line = { kind: a.kind, id: card.id, state: card.state, title: card.title };
  if (a.role) line.role = a.role;
  if (a.to) line.to = a.to;
  if (a.reason) line.reason = a.reason;
  process.stdout.write(JSON.stringify(line) + "\n");
}
