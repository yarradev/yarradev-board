#!/usr/bin/env node
/*
 * clear-lease.mjs <id> <gen> — release the lease (gen-required). Call this in EVERY branch after a
 * dispatch (advance, reject, question, error) so a crashed pass never strands a lease.
 * Prints { ok, status, outcome }. Best-effort: if it fails, the lease simply expires at its TTL.
 */
import { BoardClient } from "./lib.mjs";

const [id, gen] = process.argv.slice(2);
if (!id || gen === undefined) {
  console.error("usage: clear-lease.mjs <id> <gen>");
  process.exit(2);
}
const r = await new BoardClient().clearLease(id, Number(gen));
process.stdout.write(JSON.stringify(r) + "\n");
process.exit(r.ok ? 0 : 1);
