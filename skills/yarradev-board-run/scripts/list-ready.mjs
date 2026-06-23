#!/usr/bin/env node
/*
 * list-ready.mjs — print one JSON line per actionable card:
 *   { "kind":"work"|"advance"|"respawn"|"escalate", "id", "state", "role"?, "to"?, "reason"?, "title" }
 * `work` carries role+to; `advance` carries to; `respawn` carries role; `escalate` carries reason
 * (park the card for a human — budget exhausted / CI stalled). `title` is the card's intent. The
 * generation is NOT emitted (acts use only the gen returned by CLAIM). Non-actionable cards
 * (terminal/blocked/leased/ci-pending/ci-absent/…) are logged to stderr and skipped.
 */
import { BoardClient, loadConfig } from "./lib.mjs";
import { decide, DEFAULT_BUDGETS } from "./decide.mjs";

const cfg = loadConfig();
const budgets = { ...DEFAULT_BUDGETS, ...(cfg.budgets ?? {}) };
const client = new BoardClient();
const now = Date.now();

const cards = await client.listCards();
for (const card of cards) {
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
