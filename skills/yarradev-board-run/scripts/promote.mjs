#!/usr/bin/env node
/*
 * promote.mjs <id> <to> — advance a HUMAN-GATED stage by MOVEing at the card's CURRENT gen (no CLAIM, so
 * the human's HUMAN_GO — which is gen-stamped — stays valid; a CLAIM bump would invalidate it). The
 * board's human_go gate 422s until an accountable human has posted HUMAN_GO (run human-go.mjs as a human
 * identity). Presupposes the card was claimed at least once (current_gen>=1); a never-claimed card
 * (gen 0) returns 409 fenced (gen-required), not the human_go 422. Prints { ok, status, outcome,
 * blocked_by }. Exit 0 on committed, 1 otherwise.
 */
import { BoardClient } from "./lib.mjs";

const [id, to] = process.argv.slice(2);
if (!id || !to) {
  console.error("usage: promote.mjs <id> <to>");
  process.exit(2);
}
const client = new BoardClient({ role: "releaser" });
const card = await client.getCard(id);
if (!card || card.current_gen == null) {
  process.stdout.write(JSON.stringify({ ok: false, error: "no such card" }) + "\n");
  process.exit(1);
}
const { status, json, outcome } = await client.act({ type: "MOVE", item_id: id, gen: card.current_gen, data: { to } });
const r = { ok: outcome === "committed", status, outcome, blocked_by: json.blocked_by };
process.stdout.write(JSON.stringify(r) + "\n");
process.exit(r.ok ? 0 : 1);
