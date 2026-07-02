#!/usr/bin/env node
/*
 * hold.mjs <id> <head> [reason...] — post a security HOLD (gen-exempt; non-binding compliance park).
 * Sets hold_open; the board's no_open_hold gate blocks dev→test until a human CLEARs it. <head> = the
 * reviewed linked head. The orchestrator posts this from the advisor's verdict. Prints { ok, status, outcome }.
 */
import { makeClient, emit } from "./plugin-io.mjs";

const [id, head, ...rest] = process.argv.slice(2);
if (!id || !head) {
  console.error("usage: hold.mjs <id> <head> [reason...]");
  process.exit(2);
}
const r = await makeClient({ role: "security-advisor" }).hold(id, rest.join(" "), head);
process.exit(emit(r));
