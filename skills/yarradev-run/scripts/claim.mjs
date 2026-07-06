#!/usr/bin/env node
/*
 * claim.mjs <id> <role> [ttl_s] [--respawn] — claim a lease on a card (fence mode "claim"; grants gen+1).
 * --respawn marks this CLAIM as a re-dispatch of the SAME stage owner after a CI failure with no MOVE
 * in between (decide() kind:"respawn") — pass it on that path (SKILL.md), never on a fresh work/reclaim
 * CLAIM. It posts data.respawn=true, which the board's CLAIM fold (D4, respawn backstop / v1 parity)
 * counts toward item.transitions_count — without it, a stuck CI-fail respawn loop never approaches
 * transition_budget and is bounded only by the 60s respawn_window_ms leg.
 * Prints { ok, gen, status, outcome }. Thread the returned gen into move/clear-lease.
 * Exit 0 on committed, 1 otherwise (e.g. 409 fenced = already leased).
 */
import { makeClient, emit, genOf } from "./plugin-io.mjs";

const rawArgs = process.argv.slice(2);
const respawn = rawArgs.includes("--respawn");
const [id, role, ttl] = rawArgs.filter((a) => a !== "--respawn");
if (!id || !role) {
  console.error("usage: claim.mjs <id> <role> [ttl_s] [--respawn]");
  process.exit(2);
}
// The orchestrator identity posts CLAIM; `role` (argv) is the LEASE role (which worker will work it).
const client = makeClient({ role: "orchestrator" });
const ttlS = ttl ? Number(ttl) : undefined;
// client.claim() (vendored core) has no data passthrough for the respawn flag, so post the CLAIM act
// directly on that path — same shape client.claim() builds, plus data.respawn (see claim() in
// vendor/core.mjs's BoardClient). Matches client.claim()'s own ttlS default (1800) when unset.
const r = respawn
  ? await client.act({ type: "CLAIM", item_id: id, data: { role, ttl_s: ttlS ?? 1800, respawn: true } })
  : await client.claim(id, role, ttlS);
// Thread the granted gen (from the CLAIM dispatch) into move/clear-lease — see SKILL.md.
process.exit(emit(r, { gen: genOf(r), blocked_by: r?.blocked_by }));
