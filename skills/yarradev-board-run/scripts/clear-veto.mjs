#!/usr/bin/env node
/*
 * clear-veto.mjs <id> — the accountable-human CLEAR_VETO (gen-exempt). Clears the security VETO and
 * resumes the card. The board authorizes this ONLY for a clear_authority signatory, so run it as a
 * signatory identity (set YDB_TOKEN to the signatory's bearer). "Advisor flags; a human signs off."
 * Prints { ok, status, outcome }. Exit 0 on committed, 1 otherwise.
 */
import { BoardClient } from "./lib.mjs";

const [id] = process.argv.slice(2);
if (!id) {
  console.error("usage: clear-veto.mjs <id>");
  process.exit(2);
}
const r = await new BoardClient({ role: "human" }).clearVeto(id);
process.stdout.write(JSON.stringify(r) + "\n");
process.exit(r.ok ? 0 : 1);
