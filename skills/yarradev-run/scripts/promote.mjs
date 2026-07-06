#!/usr/bin/env node
/*
 * promote.mjs <id> <to> [role] — advance a gate that promotes (CLAIM-free MOVE at the card's CURRENT gen)
 * rather than CLAIM-and-advance. Two callers, both {kind:"promote"} out of decide():
 *   - the HUMAN gate (staging→prod): no `role` arg → defaults to `releaser` (the production-gate identity;
 *     no CLAIM keeps the human's gen-stamped HUMAN_GO valid — a CLAIM bump would invalidate it). The
 *     board's human_go gate 422s (blocked_by ⊇ human_go) until an accountable human posts HUMAN_GO.
 *   - the epic fan-in BARRIER (integrating→done): `role` = the stage's promoteAs (analyst); the board's
 *     all_children_terminal gate 422s (blocked_by ⊇ all_children_terminal) until every child is terminal.
 * `role` selects the per-role board identity the MOVE is posted under (YDB_TOKEN_<ROLE>). Presupposes the
 * card was claimed at least once (current_gen>=1); a never-claimed card (gen 0) returns 409 fenced
 * (gen-required). Prints { ok, status, outcome, blocked_by }. Exit 0 on committed, 1 otherwise.
 */
import { makeClient, emit } from "./plugin-io.mjs";

const [id, to, role = "releaser"] = process.argv.slice(2);
if (!id || !to) {
  console.error("usage: promote.mjs <id> <to> [role]");
  process.exit(2);
}
const client = makeClient({ role });
// Read the card's CURRENT gen (a promote MOVEs at it — no CLAIM, so the human's gen-stamped GO stays
// valid). The vendored core has no getItem; getEnriched returns the same snapshot fields (+ current_gen).
const card = await client.getEnriched(id);
if (!card || card.current_gen == null) {
  process.stdout.write(JSON.stringify({ ok: false, error: "no such card" }) + "\n");
  process.exit(1);
}
// core's move() returns an AppendResult; blocked_by surfaces the failing gate predicate(s) on a 422.
const r = await client.move(id, card.current_gen, to);
process.exit(emit(r, { blocked_by: r?.blocked_by }));
