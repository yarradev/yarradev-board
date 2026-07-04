#!/usr/bin/env node
/*
 * advice.mjs <id> <head> [reason...] [--role <role>] — post a non-binding advisor ADVICE (gen-exempt).
 * Records a CLEAN review at <head> so the board's advisor_clear gate goes non-vacuous and the card
 * advances — a clean/advice verdict does NOT park the card (unlike veto/hold). <head> = the reviewed
 * linked head (head-freshness). The orchestrator posts this from the dispatched advisor's advice/clean
 * verdict at EVERY advisor-dispatch path; without it a clean card has no advisor_state row →
 * advisor_clear is false forever → decide re-dispatches the advisor every tick (the clean-card livelock).
 *
 * --role <role>  acting board identity for the ADVICE post — the dispatched advisor's role for THIS
 *                stage (e.g. security-advisor, code-reviewer, or any other configured advisor). Default
 *                "security-advisor" preserves the original single-advisor behavior when the flag is
 *                omitted; SKILL.md now passes it explicitly (the stage's advisor role) at every call
 *                site, since a stage's advisor is not always security-advisor (Task A8) — without the
 *                caller threading its own role, a non-security-advisor's clean/advice review would be
 *                misattributed to security-advisor's board identity.
 *
 * Prints { ok, status, outcome }.
 */
import { makeClient, emit } from "./plugin-io.mjs";

function parseArgs(argv) {
  const rest = [];
  let role = "security-advisor";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--role") {
      role = argv[++i];
      continue;
    }
    rest.push(argv[i]);
  }
  const [id, head, ...reasonParts] = rest;
  return { id, head, reason: reasonParts.join(" "), role };
}

const { id, head, reason, role } = parseArgs(process.argv.slice(2));
if (!id || !head) {
  console.error("usage: advice.mjs <id> <head> [reason...] [--role <role>]");
  process.exit(2);
}
const r = await makeClient({ role }).advice(id, head, reason);
process.exit(emit(r));
