#!/usr/bin/env node
/*
 * answer.mjs — answer an open question on a card (ANSWER, gen-exempt).
 * Usage: node answer.mjs <id> [text]
 * If text is omitted, a default resume message is used.
 * Posts under the human identity (ANSWER requires human governance).
 */
import { BoardClient } from "./lib.mjs";

const id = process.argv[2];
const text = process.argv.slice(3).join(" ") || "Resume the card.";

if (!id) {
  console.error("usage: node answer.mjs <id> [text]");
  process.exit(1);
}

const client = new BoardClient({ role: "human" });
const { status, outcome } = await client.act({
  type: "ANSWER",
  item_id: id,
  data: { text },
});

console.log(JSON.stringify({ ok: outcome === "committed", status, outcome }));
if (!outcome || outcome !== "committed") process.exit(1);
