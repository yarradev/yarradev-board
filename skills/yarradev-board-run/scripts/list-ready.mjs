#!/usr/bin/env node
/*
 * list-ready.mjs — print one JSON line per workable card: { id, state, role, to, current_gen }.
 * Non-workable cards (terminal/blocked/leased/unknown) are logged to stderr and skipped.
 * The orchestrator skill reads stdout to decide what to claim+dispatch this pass.
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
      JSON.stringify({ id: card.id, state: card.state, role: a.role, to: a.to, current_gen: card.current_gen }) + "\n",
    );
  } else {
    process.stderr.write(`skip ${card.id} (${card.state}): ${a.reason}\n`);
  }
}
