#!/usr/bin/env node
/*
 * list-ready.mjs — print one JSON line per actionable card:
 *   { "kind":"work"|"advance"|"respawn", "id", "state", "role"?, "to"?, "title" }
 * `work` carries role+to (spawn the owner); `advance` carries to (MOVE, no spawn); `respawn` carries
 * role (re-spawn the owner). `title` is the card's intent. The generation is intentionally NOT emitted
 * — acts must use only the gen returned by CLAIM. Non-actionable cards (terminal/blocked/leased/
 * ci-pending/ci-absent/…) are logged to stderr and skipped.
 */
import { BoardClient, loadConfig } from "./lib.mjs";
import { decide } from "./decide.mjs";

const cfg = loadConfig();
const client = new BoardClient();
const now = Date.now();

const cards = await client.listCards();
for (const card of cards) {
  const a = decide(card, cfg.lifecycle, now);
  if (a.kind === "noop") {
    process.stderr.write(`skip ${card.id} (${card.state}): ${a.reason}\n`);
    continue;
  }
  const line = { kind: a.kind, id: card.id, state: card.state, title: card.title };
  if (a.role) line.role = a.role;
  if (a.to) line.to = a.to;
  process.stdout.write(JSON.stringify(line) + "\n");
}
