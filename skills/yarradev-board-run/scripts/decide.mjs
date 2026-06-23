/*
 * yarradev-board — pure per-card decision (gate-aware).
 *
 * PROVENANCE: extends yarradev-platform/orchestrator/src/decide.ts with a mechanical-gate branch
 * (mirrors v1 eval-gates.js mechanical(): work / advance / respawn / wait). Keep the judgement path
 * in sync with the platform source.
 *
 * Lifecycle: Record<state, { owner, to|null, gate?: "judgement"|"mechanical" }>. `to:null` = terminal;
 * `gate` absent or "judgement" ⇒ the subagent's verdict drives the MOVE (Slice 1 behaviour).
 *
 * Returns one of:
 *   { kind:"work",    role, to }  spawn the owner (judgement, or mechanical with no PR linked yet)
 *   { kind:"advance", to }        mechanical CI is green → orchestrator MOVEs without spawning
 *   { kind:"respawn", role }      mechanical CI failed + lease expired → re-spawn the owner to fix
 *   { kind:"noop",    reason }     terminal | unknown-state | blocked | leased | ci-pending|blocked|absent
 *
 * Card fields read: state, blocked, lease_expiry_ts, ci_rollup, linked_head_sha.
 */
export function decide(card, lc, nowMs) {
  const stage = lc[card.state];
  if (!stage) return { kind: "noop", reason: "unknown-state" };
  if (stage.to == null) return { kind: "noop", reason: "terminal" };
  if (card.blocked) return { kind: "noop", reason: "blocked" }; // governance flag (≠ ci_rollup "blocked")

  const leased = card.lease_expiry_ts != null && card.lease_expiry_ts > nowMs;

  // Judgement stage (default): one spawn per pass; the verdict drives MOVE/REJECT.
  if (stage.gate !== "mechanical") {
    if (leased) return { kind: "noop", reason: "leased" };
    return { kind: "work", role: stage.owner, to: stage.to };
  }

  // Mechanical stage: derive intent from (lease, linked_head_sha, ci_rollup). Order matters —
  // the leased check precedes the CI checks so a stale rollup can't re-spawn over a live worker.
  if (leased) return { kind: "noop", reason: "leased" };
  if (card.linked_head_sha == null) return { kind: "work", role: stage.owner, to: stage.to }; // no PR yet
  const ci = card.ci_rollup ?? "absent";
  if (ci === "success") return { kind: "advance", to: stage.to };
  if (ci === "failure") return { kind: "respawn", role: stage.owner };
  return { kind: "noop", reason: "ci-" + ci }; // pending | blocked | absent → wait for CI
}
