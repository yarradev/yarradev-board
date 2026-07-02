#!/usr/bin/env node
/*
 * claim.mjs <id> <role> [ttl_s] — claim a lease on a card (fence mode "claim"; grants gen+1).
 * Prints { ok, gen, status, outcome }. Thread the returned gen into move/clear-lease.
 * Exit 0 on committed, 1 otherwise (e.g. 409 fenced = already leased).
 */
import { makeClient, emit, genOf } from "./plugin-io.mjs";

const [id, role, ttl] = process.argv.slice(2);
if (!id || !role) {
  console.error("usage: claim.mjs <id> <role> [ttl_s]");
  process.exit(2);
}
// The orchestrator identity posts CLAIM; `role` (argv) is the LEASE role (which worker will work it).
const r = await makeClient({ role: "orchestrator" }).claim(id, role, ttl ? Number(ttl) : undefined);
// Thread the granted gen (from the CLAIM dispatch) into move/clear-lease — see SKILL.md.
process.exit(emit(r, { gen: genOf(r) }));
