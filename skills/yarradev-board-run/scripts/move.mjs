#!/usr/bin/env node
/*
 * move.mjs <id> <gen> <to> — post a gen-required MOVE to <to> (forward = advance, backward = reject).
 * Prints { ok, status, outcome }. 409 = fenced (stale gen / expired lease); 422 = gate_blocked/bad_act.
 * Exit 0 on committed, 1 otherwise.
 */
import { makeClient, emit } from "./plugin-io.mjs";

const [id, gen, to, role] = process.argv.slice(2);
if (!id || gen === undefined || !to) {
  console.error("usage: move.mjs <id> <gen> <to> [role]");
  process.exit(2);
}
// `role` = the stage owner (designer/developer/tester/releaser) → MOVE posts under that per-role
// identity; omit to use the shared YDB_TOKEN.
const r = await makeClient({ role }).move(id, Number(gen), to);
process.exit(emit(r));
