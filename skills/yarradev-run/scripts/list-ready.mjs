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
  while (cursor && cursor.parent_id) {
    const parent = enriched.get(cursor.parent_id);
    if (!parent) break;
    if (parent.type === "epic") return parent.priority ?? 50;
    cursor = parent;
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
// Sort key: (root_epic_priority, card_priority, card_id)
const sorted = [...enriched.values()].sort((a, b) => {
  const epA = epicPriorityOf(a, enriched);
  const epB = epicPriorityOf(b, enriched);
  if (epA !== epB) return epA - epB;
  const pA = a.priority ?? 100;
  const pB = b.priority ?? 100;
  if (pA !== pB) return pA - pB;
  return (a.id ?? "").localeCompare(b.id ?? "");
});

// Phase 3: route each card through decide() in priority order
for (const card of sorted) {
  const a = decide(card, cfg.lifecycle, policy, now);
  if (a.kind === "noop") {
    process.stderr.write(`skip ${card.id} (${card.state}): ${a.reason}\n`);
    continue;
  }
  const line = { kind: a.kind, id: card.id, state: card.state, title: card.title };
  if (a.role) line.role = a.role;
  if (a.to) line.to = a.to;
  if (a.reason) line.reason = a.reason;
  process.stdout.write(JSON.stringify(line) + "\n");
}
