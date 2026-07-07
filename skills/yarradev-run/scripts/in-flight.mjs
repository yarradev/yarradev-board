/*
 * in-flight.mjs — detect cards with an UNRESOLVED (still-running) dispatch, so list-ready can skip
 * re-dispatching them (GH #27). Pure helper over the dispatch manifest content — no I/O, injected `now`
 * for unit testing.
 *
 * Background: the dispatch tool (~/work/tools/yarradev-dispatch) is async/fire-and-forget — it writes a
 * `pending` entry to ~/.local/share/claude-bg/dispatch-manifest.jsonl on dispatch, and the background
 * run.sh appends a `done` entry (same `verdictPath`) when `claude -p` exits. Lease-TTL expiry bumps
 * current_gen (board reclaimDueLeasesSync), so dispatch-and-wait times out near the TTL and the conductor
 * CLEAR_LEASEs and moves on. WITHOUT this filter, the next pass sees the card reclaimable and re-dispatches
 * it while the ORIGINAL subagent is still running → two subagents edit the same worktree concurrently
 * (conflicting edits, double cost).
 *
 * Rule: a `pending` whose `verdictPath` has no matching `done` AND whose `dispatchedAt` is within `staleS`
 * ⇒ the subagent is still running ⇒ the card is in-flight (skip it). Once `done` lands, the card is
 * actionable again (re-dispatched cleanly next pass — the verdict can't be recovered directly because the
 * lease bumped the gen; full recovery is async-reconcile, GH #28). A pending older than `staleS` with no
 * `done` is presumed dead (the subagent exited without run.sh appending done) so the card isn't blocked
 * forever.
 */

/**
 * @param {string} manifestContent raw JSONL ("" / null / undefined → empty set)
 * @param {number} now epoch ms (injected for testability)
 * @param {number} staleS a pending older than this (with no matching done) is presumed dead
 * @returns {Set<string>} cardIds with a recent unresolved pending dispatch
 */
export function inFlightCardIds(manifestContent, now, staleS) {
  const inFlight = new Set();
  if (!manifestContent) return inFlight;
  const done = new Set();
  const pending = [];
  for (const line of manifestContent.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try {
      e = JSON.parse(t);
    } catch {
      continue; // malformed/partial line — skip, never crash on a bad append
    }
    if (!e || !e.verdictPath || !e.cardId) continue;
    if (e.status === "done") {
      done.add(e.verdictPath);
    } else if (e.status === "pending") {
      pending.push({ cardId: String(e.cardId), verdictPath: String(e.verdictPath), ts: Date.parse(e.dispatchedAt || "") });
    }
  }
  for (const p of pending) {
    if (done.has(p.verdictPath)) continue; // finished → not in-flight
    // Only treat as stale when we have a valid timestamp AND it's old. An untimestamped pending is treated
    // as in-flight (conservative — never risk a duplicate); the dispatch tool always writes dispatchedAt.
    if (!Number.isNaN(p.ts) && now - p.ts >= staleS * 1000) continue;
    inFlight.add(p.cardId);
  }
  return inFlight;
}
