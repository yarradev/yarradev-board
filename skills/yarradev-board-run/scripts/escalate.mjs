#!/usr/bin/env node
/*
 * escalate.mjs <id> [reason...] — park a card for a human. Opens a question via an ASK act
 * (gen-exempt → no CLAIM/gen): the board sets blocked=true, so decide() skips the card on every
 * subsequent pass (no dispatch, no subscription spend) until a human posts an ANSWER to resume it.
 * Used on budget exhaustion (transition budget, CI stall, or a board "bounce budget exhausted" 422).
 * Prints { ok, status, outcome }. Exit 0 on committed, 1 otherwise.
 */
import { BoardClient } from "./lib.mjs";

const [id, ...rest] = process.argv.slice(2);
if (!id) {
  console.error("usage: escalate.mjs <id> [reason...]");
  process.exit(2);
}
const r = await new BoardClient({ role: "orchestrator" }).escalate(id, rest.join(" "));
process.stdout.write(JSON.stringify(r) + "\n");
process.exit(r.ok ? 0 : 1);
