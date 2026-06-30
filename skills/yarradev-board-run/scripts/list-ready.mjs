#!/usr/bin/env node
/*
 * list-ready.mjs — print one JSON line per actionable card:
 *   { "kind":"work"|"advance"|"respawn"|"escalate"|"promote", "id", "state", "role"?, "to"?, "reason"?, "title" }
 * `work` carries role+to; `advance` carries role+to; `respawn` carries role; `promote` carries to
 * (human-gated stage); `escalate` carries reason (budget exhausted / CI stalled). `title` is the intent. The
 * generation is NOT emitted (acts use only the gen returned by CLAIM). Non-actionable cards
 * (terminal/blocked/leased/ci-pending/ci-absent/…) are logged to stderr and skipped.
 */
import { BoardClient, loadConfig } from "./lib.mjs";
import { decide, DEFAULT_BUDGETS } from "./decide.mjs";

const cfg = loadConfig();
const budgets = { ...DEFAULT_BUDGETS, ...(cfg.budgets ?? {}) };
const client = new BoardClient({ role: "orchestrator" });
const now = Date.now();

const cards = await client.listCards();
for (const card of cards) {
  // A card with no id is corrupt (e.g. a CREATE that committed with an empty item_id): no act can
  // target it — every non-CREATE act fence-fails on the missing item — so it can never be actioned.
  // Skip it so it can't wedge the pass (it would otherwise sort first by id ASC and starve real work).
  if (!card.id) {
    process.stderr.write(`skip <empty-id> (${card.state}): corrupt item — unactionable\n`);
    continue;
  }
  const a = decide(card, cfg.lifecycle, now, budgets);
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
