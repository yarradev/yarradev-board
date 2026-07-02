#!/usr/bin/env node
/*
 * veto.mjs <id> <head> [reason...] — post a security VETO (gen-exempt). Sets veto_held; the board's
 * no_open_veto gate then blocks dev→test (even with CI green) until an accountable human runs
 * clear-veto.mjs (a clear_authority signatory). <head> = the reviewed linked head (head-freshness).
 * The orchestrator posts this from the security-advisor's verdict. Prints { ok, status, outcome }.
 */
import { makeClient, emit } from "./plugin-io.mjs";

const [id, head, ...rest] = process.argv.slice(2);
if (!id || !head) {
  console.error("usage: veto.mjs <id> <head> [reason...]");
  process.exit(2);
}
const r = await makeClient({ role: "security-advisor" }).veto(id, rest.join(" "), head);
process.exit(emit(r));
