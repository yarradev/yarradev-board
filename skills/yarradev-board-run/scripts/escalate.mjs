#!/usr/bin/env node
/*
 * escalate.mjs <id> [reason...] — park a card for a human. Opens a question via an ASK act
 * (gen-exempt → no CLAIM/gen): the board sets blocked=true, so decide() skips the card on every
 * subsequent pass (no dispatch, no subscription spend) until a human posts an ANSWER to resume it.
 * Used on budget exhaustion (transition budget, CI stall, or a board "bounce budget exhausted" 422).
 * Prints { ok, status, outcome }. Exit 0 on committed, 1 otherwise.
 */
import { makeClient, emit } from "./plugin-io.mjs";

const [id, ...rest] = process.argv.slice(2);
if (!id) {
  console.error("usage: escalate.mjs <id> [reason...]");
  process.exit(2);
}
// Parking a card for a human = an ASK with cat:"escalation" (the board sets blocked=true so decide()
// skips it until a human ANSWERs). Use the vendored core's ask() — NOT its escalate(): core.escalate()
// posts the ESCALATE act, a NON-blocking surfacing flag that would NOT park the card, breaking the
// "budget exhausted → park for a human" contract this script (and SKILL.md step "escalate") relies on.
const r = await makeClient({ role: "orchestrator" }).ask(id, "escalation", rest.join(" "));
process.exit(emit(r));
