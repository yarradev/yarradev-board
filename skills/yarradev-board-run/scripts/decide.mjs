/*
 * yarradev-board — pure per-card decision (gate-aware + budget-aware).
 *
 * PROVENANCE: extends yarradev-platform/orchestrator/src/decide.ts; mechanical-gate + budgets mirror
 * v1 eval-gates.js (mechanical() + the transition_budget/bounce_limit escalate backstop).
 *
 * Lifecycle: Record<state, { owner, to|null, gate?: "judgement"|"mechanical"|"human" }>. `to:null` = terminal.
 * Budgets (4th arg): { transition_budget, bounce_limit, respawn_window_ms, per_edge_overrides }.
 *   - transition_budget: board-counted (MOVE/REJECT bump transitions_count) → bounds all thrash that transitions.
 *   - respawn_window_ms: time bound on the in-place CI-failure loop (respawns are NOT board-counted).
 *   - bounce_limit is enforced by the BOARD on REJECT (422); the orchestrator escalates on that 422.
 *
 * The `gate` tag is a PLUGIN-SIDE routing hint for this function only. The board's REAL enforcement is the
 * compiled GateExpr on each transition: a "mechanical" stage's forward edge must declare {p:"ci_green"}
 * (+ no_open_veto/no_open_hold if an advisor watches it); a "human" stage's edge must declare {p:"human_go"}.
 * Keep the two in sync — see SKILL.md "Config & auth".
 *
 * Returns: { kind:"work",role,to } | { kind:"advance",role,to } | { kind:"respawn",role }
 *        | { kind:"promote",to } | { kind:"escalate",reason } | { kind:"noop",reason }.
 * Card fields read: state, blocked, lease_expiry_ts, veto_held, hold_open, ci_rollup, linked_head_sha,
 *   transitions_count, parked_since_ts.
 */
export const DEFAULT_BUDGETS = {
  transition_budget: 50,
  bounce_limit: 3,
  respawn_window_ms: 60000,
  per_edge_overrides: {},
};

export function decide(card, lc, nowMs, budgets = DEFAULT_BUDGETS) {
  const stage = lc[card.state];
  if (!stage) return { kind: "noop", reason: "unknown-state" };
  if (stage.to == null) return { kind: "noop", reason: "terminal" };
  if (card.blocked === true) return { kind: "noop", reason: "blocked" }; // parked: open question / escalation (ASK)

  const leased = card.lease_expiry_ts != null && card.lease_expiry_ts > nowMs;
  if (leased) return { kind: "noop", reason: "leased" }; // a worker holds it this pass — never double-spawn

  // Security-advisor verdicts dominate: a vetoed/held card does NO further work (no quota) until an
  // accountable human CLEARs it. This park is LOAD-BEARING on the advance path — the board's no_open_veto
  // gate is gen-scoped, so a CLAIM-bumped advance would slip past it; parking here off the PERSISTENT
  // item.veto_held is what actually stops a vetoed card from advancing. (item.veto_held is sticky across
  // gens — a stronger park than the board gate; a TTL reclaim won't auto-release it, only CLEAR_VETO does.)
  if (card.veto_held === true) return { kind: "noop", reason: "veto-open" };
  if (card.hold_open === true) return { kind: "noop", reason: "hold-open" };

  // Global thrash backstop (board-counted on MOVE/REJECT) → park for a human past the budget.
  if ((card.transitions_count ?? 0) >= budgets.transition_budget) {
    return { kind: "escalate", reason: "transition-budget" };
  }

  // Human-gated stage (e.g. production): only an accountable human's HUMAN_GO advances it. The
  // orchestrator attempts the MOVE (the board's human_go gate is the enforcer); agents cannot self-approve.
  if (stage.gate === "human") return { kind: "promote", to: stage.to };

  // Judgement stage (default): the subagent's verdict drives MOVE/REJECT.
  if (stage.gate !== "mechanical") {
    return { kind: "work", role: stage.owner, to: stage.to };
  }

  // Mechanical stage: derive intent from (linked_head_sha, ci_rollup), bounded by time-in-state.
  if (card.linked_head_sha == null) return { kind: "work", role: stage.owner, to: stage.to }; // no PR yet
  const ci = card.ci_rollup ?? "absent";
  if (ci === "success") return { kind: "advance", role: stage.owner, to: stage.to };
  if (ci === "failure") {
    // CI keeps failing in place; respawns aren't board-counted, so bound the loop by time-in-state.
    const since = card.parked_since_ts ?? nowMs;
    if (nowMs - since > budgets.respawn_window_ms) return { kind: "escalate", reason: "ci-stalled" };
    return { kind: "respawn", role: stage.owner };
  }
  return { kind: "noop", reason: "ci-" + ci }; // pending | blocked | absent → wait for CI
}
