#!/usr/bin/env node
/*
 * reject.mjs <id> <gen> <to> — post a gen-required REJECT to a backward state (e.g. test->dev, dev->spec).
 * REJECT is a DISTINCT act type from MOVE: the board only matches a backward edge declared in its
 * compiled CONFIG as type:"REJECT" (a MOVE on a REJECT edge → 422 "bad transition"), and per-edge
 * bounce budgets fire on REJECT. Prints { ok, status, outcome }. Exit 0 on committed, 1 otherwise.
 */
import { BoardClient } from "./lib.mjs";

const [id, gen, to, role] = process.argv.slice(2);
if (!id || gen === undefined || !to) {
  console.error("usage: reject.mjs <id> <gen> <to> [role]");
  process.exit(2);
}
// `role` = the stage owner posting the REJECT → its per-role identity; omit to use the shared YDB_TOKEN.
const r = await new BoardClient({ role }).reject(id, Number(gen), to);
process.stdout.write(JSON.stringify(r) + "\n");
process.exit(r.ok ? 0 : 1);
