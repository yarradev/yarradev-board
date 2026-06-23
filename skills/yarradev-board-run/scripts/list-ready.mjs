#!/usr/bin/env node
/*
 * list-ready.mjs — print one JSON line per workable card: { id, state, role, to, title }.
 * `title` is the card's intent (passed to the dispatched subagent). The generation is intentionally
 * NOT emitted: acts must use only the gen returned by CLAIM (the pre-claim gen would 409).
 * Non-workable cards (terminal/blocked/leased/unknown) are logged to stderr and skipped.
 */
import { BoardClient, loadConfig } from "./lib.mjs";
import { decide } from "./decide.mjs";

const cfg = loadConfig();
const client = new BoardClient();
const now = Date.now();

const cards = await client.listCards();
for (const card of cards) {
  const a = decide(card, cfg.lifecycle, now);
  if (a.kind === "work") {
    process.stdout.write(
      JSON.stringify({ id: card.id, state: card.state, role: a.role, to: a.to, title: card.title }) + "\n",
    );
  } else {
    process.stderr.write(`skip ${card.id} (${card.state}): ${a.reason}\n`);
  }
}
