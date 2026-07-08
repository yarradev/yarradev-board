#!/usr/bin/env node
/*
 * list-ready.mjs — print one JSON line per actionable card:
 *   { "kind":"work"|"advance"|"respawn"|"reclaim"|"escalate"|"promote", "id", "state", "role"?, "to"?, "reason"?, "title" }
 * `work` carries role+to; `advance` carries role+to; `respawn` carries role; `reclaim` carries role+to
 * (an expired lease — re-dispatch the stage owner, same as work); `promote` carries to (human-gated stage);
 * `escalate` carries reason (budget exhausted / CI stalled / board-drift). `title` is the intent. The
 * generation is NOT emitted (acts use only the gen returned by CLAIM). Non-actionable cards
 * (terminal/blocked/leased/ci-pending/ci-absent/…) are logged to stderr and skipped.
 *
 * Drives from the vendored orchestrator-core: decide() is the shipped runtime engine (arg order
 * card, lifecycle, policy, nowMs — budgets are sourced internally). decide() reads EnrichedItem fields
 * (open_questions/vetoes/next_transitions), so each card is fetched via getEnriched(), not the thin
 * list projection.
 *
 * Task 8 — single-source the lifecycle: before routing anything, fetch the live board's GET /config
 * machine and assert it agrees with this plugin's board.json lifecycle (assertLifecycleCoherent).
 * FAIL CLOSED: a null machine (board unreachable / no active config) or a coherence mismatch both
 * abort the pass with a non-zero exit rather than routing cards against a lifecycle that may no
 * longer match what the board actually enforces.
 */
import { decide, assertLifecycleCoherent } from "./vendor/core.mjs";
import { makeClient, loadConfig } from "./plugin-io.mjs";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inFlightCardIds } from "./in-flight.mjs";

/**
 * Resolve the priority of the root epic for a card. If the card IS an epic, its own
 * priority is the group key. If it has a parent, walk up via enriched cache until
 * we find an epic or hit a card with no parent. Standalone cards use their own priority.
 *
 * @param {object} card — enriched card with { id, type, parent_id?, priority? }
 * @param {Map<string, object>} enriched — id → enriched card (all fetched cards)
 * @returns {number} root epic priority, or the card's own priority if standalone
 */
function epicPriorityOf(card, enriched) {
  if (card.type === "epic") return card.priority ?? 50;
  let cursor = card;
  let depth = 0;
  while (cursor && cursor.parent_id && depth < 50) {
    const parent = enriched.get(cursor.parent_id);
    if (!parent) break;
    if (parent.type === "epic") return parent.priority ?? 50;
    cursor = parent;
    depth++;
  }
  // Standalone or unresolvable parent chain — use own priority
  return card.priority ?? 100;
}

const cfg = loadConfig();
// TeamPolicy for decide(). core.decide currently sources the advisor role from lifecycle[state].advisors
// (policy is presently unused), but the signature requires a well-formed TeamPolicy — derive from cfg's
// policy if present, else an empty advisor list.
const policy = { advisors: cfg.policy?.advisors ?? [] };
const client = makeClient({ role: "orchestrator" });
const now = Date.now();

// Fail closed on ANY machine-fetch/coherence problem: getMachine() returns null on an HTTP error
// (non-2xx → no active config / 5xx), but a transport failure (DNS, connection refused, TLS) makes
// fetch REJECT — catch that too so it produces the same clean refuse-to-route line, not a raw stack trace.
try {
  const machine = await client.getMachine();
  if (!machine) {
    process.stderr.write("list-ready: refusing to route — GET /config returned no machine (board unreachable or no active config)\n");
    process.exit(1);
  }
  assertLifecycleCoherent(cfg.lifecycle, machine);
} catch (e) {
  process.stderr.write(`list-ready: refusing to route — ${e.message}\n`);
  process.exit(1);
}

// GET /cards returns { items, nextAfterId }; the vendored core types listCards() as ItemSnapshot[] and
// returns the body verbatim, so accept either shape (array now, or a fixed array-returning core later).
const listed = await client.listCards();
const items = Array.isArray(listed) ? listed : (listed?.items ?? []);

// Phase 1: collect all enriched cards
const enriched = new Map();
for (const summary of items) {
  if (!summary.id) {
    process.stderr.write(`skip <empty-id> (${summary.state}): corrupt item — unactionable\n`);
    continue;
  }
  const card = await client.getEnriched(summary.id);
  if (!card) {
    process.stderr.write(`skip ${summary.id} (${summary.state}): enriched fetch returned nothing (see any [boardClient] HTTP-status line above)\n`);
    continue;
  }
  enriched.set(card.id, card);
}

// Phase 2: resolve root epic priorities and sort
// Sort key: (root_epic_priority, card_priority, created_ts?, card_id)
// The created_ts tie-break (GH #16) only engages when BOTH tied cards expose a creation timestamp on the
// enriched projection — older first (FIFO queue semantics). Without it, two default-priority cards
// (e.g. a UUID-named backlog card and a named epic card) fall through to id-localeCompare, which lets a
// UUID ASCII prefix ('1' < 'c') jump named work arbitrarily. Once the board exposes created_ts/created_at
// on every enriched card, this activates and removes that accidental ordering.
const tsOf = (c) => c.created_ts ?? c.created_at ?? null;
const sorted = [...enriched.values()].sort((a, b) => {
  const epA = epicPriorityOf(a, enriched);
  const epB = epicPriorityOf(b, enriched);
  if (epA !== epB) return epA - epB;
  const pA = a.priority ?? 100;
  const pB = b.priority ?? 100;
  if (pA !== pB) return pA - pB;
  const tA = tsOf(a);
  const tB = tsOf(b);
  if (tA != null && tB != null && tA !== tB) return Number(tA) - Number(tB);
  return (a.id ?? "").localeCompare(b.id ?? "");
});

// In-flight dispatch filter (GH #27): a long subagent outlives the lease (lease-TTL expiry bumps
// current_gen, so dispatch-and-wait times out near the TTL and the conductor CLEAR_LEASEs). Without this,
// the next pass reclaims + re-dispatches the card while the ORIGINAL subagent is still running → duplicate.
// Skip cards whose latest dispatch is pending with no matching done and is recent; re-dispatchable once
// the subagent finishes (done) or the entry goes stale (presumed dead).
const staleS = Number(cfg.runtime?.inflightStaleS ?? process.env.YDB_INFLIGHT_STALE_S ?? 7200);
const manifestStateDir = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share", "claude-bg");
const manifestPath = join(manifestStateDir, "dispatch-manifest.jsonl");
let inFlight = new Set();
try {
  if (existsSync(manifestPath)) inFlight = inFlightCardIds(readFileSync(manifestPath, "utf8"), now, staleS);
} catch (e) {
  process.stderr.write(`list-ready: dispatch manifest unreadable (${e.message}); in-flight filter disabled\n`);
}

// Phase 3: route each card through decide() in priority order
for (const card of sorted) {
  const a = decide(card, cfg.lifecycle, policy, now);
  if (a.kind === "noop") {
    process.stderr.write(`skip ${card.id} (${card.state}): ${a.reason}\n`);
    continue;
  }
  if (inFlight.has(card.id)) {
    process.stderr.write(`skip ${card.id} (${card.state}): dispatch in-flight (subagent still running; not re-dispatched — GH #27)\n`);
    continue;
  }
  // Dependency gate (GH #32): a card whose deps aren't resolved (the board's deps_resolved projection)
  // is not actionable until each dep reaches `done`. Backward-compatible — a card with the field absent
  // (older board, pre-deploy) is treated as resolved (undefined !== false), so this is a no-op until the
  // dependency model ships.
  if (card.deps_resolved === false) {
    // Prefer the board's `unresolved_deps` (just the blockers + why: not-done vs missing) over the full
    // depends_on list; fall back to depends_on on boards that don't project it yet.
    const unresolved = Array.isArray(card.unresolved_deps) ? card.unresolved_deps : [];
    const detail = unresolved.length
      ? unresolved.map((d) => `${d?.id ?? "?"}(${d?.reason ?? "?"})`).join(", ")
      : (Array.isArray(card.depends_on) ? card.depends_on.join(", ") : "");
    process.stderr.write(`skip ${card.id} (${card.state}): deps unresolved — blocked on [${detail}] (GH #32)\n`);
    continue;
  }
  const line = { kind: a.kind, id: card.id, state: card.state, title: card.title };
  if (a.role) line.role = a.role;
  if (a.to) line.to = a.to;
  if (a.reason) line.reason = a.reason;
  process.stdout.write(JSON.stringify(line) + "\n");
}
