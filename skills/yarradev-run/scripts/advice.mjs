#!/usr/bin/env node
/*
 * advice.mjs <id> <head> [reason...] — post a non-binding security ADVICE (gen-exempt). Records a CLEAN
 * advisor review at <head> so the board's advisor_clear gate goes non-vacuous and the card advances — a
 * clean/advice verdict does NOT park the card (unlike veto/hold). <head> = the reviewed linked head
 * (head-freshness). The orchestrator posts this from the security-advisor's advice/clean verdict at EVERY
 * advisor-dispatch path; without it a clean card has no advisor_state row → advisor_clear is false forever
 * → decide re-dispatches the advisor every tick (the clean-card livelock). Prints { ok, status, outcome }.
 */
import { makeClient, emit } from "./plugin-io.mjs";

const [id, head, ...rest] = process.argv.slice(2);
if (!id || !head) {
  console.error("usage: advice.mjs <id> <head> [reason...]");
  process.exit(2);
}
const r = await makeClient({ role: "security-advisor" }).advice(id, head, rest.join(" "));
process.exit(emit(r));
