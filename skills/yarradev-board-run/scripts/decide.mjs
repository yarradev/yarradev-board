/*
 * yarradev-board — pure per-card decision.
 *
 * PROVENANCE: ported verbatim (logic) from yarradev-platform/orchestrator/src/decide.ts (decide()).
 * Keep in sync with that source.
 *
 * Lifecycle is client-side config: Record<state, { owner, to|null }>. `to: null` = terminal.
 * Returns { kind:"work", role, to } or { kind:"noop", reason }.
 */
export function decide(card, lc, nowMs) {
  const stage = lc[card.state];
  if (!stage) return { kind: "noop", reason: "unknown-state" };
  if (stage.to == null) return { kind: "noop", reason: "terminal" };
  if (card.blocked) return { kind: "noop", reason: "blocked" };
  if (card.lease_expiry_ts != null && card.lease_expiry_ts > nowMs) return { kind: "noop", reason: "leased" };
  return { kind: "work", role: stage.owner, to: stage.to };
}
