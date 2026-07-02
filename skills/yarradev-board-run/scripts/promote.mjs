#!/usr/bin/env node
/*
 * promote.mjs <id> <to> — advance a HUMAN-GATED stage by MOVEing at the card's CURRENT gen (no CLAIM, so
 * the human's HUMAN_GO — which is gen-stamped — stays valid; a CLAIM bump would invalidate it). The
 * board's human_go gate 422s until an accountable human has posted HUMAN_GO (run human-go.mjs as a human
 * identity). Presupposes the card was claimed at least once (current_gen>=1); a never-claimed card
 * (gen 0) returns 409 fenced (gen-required), not the human_go 422. Prints { ok, status, outcome,
 * blocked_by }. Exit 0 on committed, 1 otherwise.
 */
import { makeClient, emit } from "./plugin-io.mjs";

const [id, to] = process.argv.slice(2);
if (!id || !to) {
  console.error("usage: promote.mjs <id> <to>");
  process.exit(2);
}
const client = makeClient({ role: "releaser" });
// Read the card's CURRENT gen (a promote MOVEs at it — no CLAIM, so the human's gen-stamped GO stays
// valid). The vendored core has no getItem; getEnriched returns the same snapshot fields (+ current_gen).
const card = await client.getEnriched(id);
if (!card || card.current_gen == null) {
  process.stdout.write(JSON.stringify({ ok: false, error: "no such card" }) + "\n");
  process.exit(1);
}
// core's move() returns an AppendResult; blocked_by surfaces the failing gate predicate(s) on a 422.
const r = await client.move(id, card.current_gen, to);
process.exit(emit(r, { blocked_by: r.blocked_by }));
