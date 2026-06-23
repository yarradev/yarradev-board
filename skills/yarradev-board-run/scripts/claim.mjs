#!/usr/bin/env node
/*
 * claim.mjs <id> <role> [ttl_s] — claim a lease on a card (fence mode "claim"; grants gen+1).
 * Prints { ok, gen, status, outcome }. Thread the returned gen into move/clear-lease.
 * Exit 0 on committed, 1 otherwise (e.g. 409 fenced = already leased).
 */
import { BoardClient } from "./lib.mjs";

const [id, role, ttl] = process.argv.slice(2);
if (!id || !role) {
  console.error("usage: claim.mjs <id> <role> [ttl_s]");
  process.exit(2);
}
const r = await new BoardClient().claim(id, role, ttl ? Number(ttl) : undefined);
process.stdout.write(JSON.stringify(r) + "\n");
process.exit(r.ok ? 0 : 1);
