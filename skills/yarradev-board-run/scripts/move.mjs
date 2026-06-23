#!/usr/bin/env node
/*
 * move.mjs <id> <gen> <to> — post a gen-required MOVE to <to> (forward = advance, backward = reject).
 * Prints { ok, status, outcome }. 409 = fenced (stale gen / expired lease); 422 = gate_blocked/bad_act.
 * Exit 0 on committed, 1 otherwise.
 */
import { BoardClient } from "./lib.mjs";

const [id, gen, to] = process.argv.slice(2);
if (!id || gen === undefined || !to) {
  console.error("usage: move.mjs <id> <gen> <to>");
  process.exit(2);
}
const r = await new BoardClient().move(id, Number(gen), to);
process.stdout.write(JSON.stringify(r) + "\n");
process.exit(r.ok ? 0 : 1);
