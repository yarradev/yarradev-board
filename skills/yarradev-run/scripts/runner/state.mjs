import { inFlightCardIds } from "../in-flight.mjs";

export function inflightRows(manifestContent, now, staleS) {
  const live = inFlightCardIds(manifestContent, now, staleS); // Set<cardId>
  const rows = [];
  const seen = new Set();
  for (const line of (manifestContent ?? "").split("\n")) {
    const t = line.trim(); if (!t) continue;
    let e; try { e = JSON.parse(t); } catch { continue; }
    if (!e || e.status !== "pending" || !live.has(String(e.cardId))) continue;
    if (seen.has(e.verdictPath)) continue; seen.add(e.verdictPath);
    const ts = Date.parse(e.dispatchedAt ?? "");
    rows.push({ cardId: String(e.cardId), role: e.role ?? "?", verdictPath: e.verdictPath, ageS: Number.isNaN(ts) ? null : Math.round((now - ts) / 1000) });
  }
  return rows;
}

export function buildStatus({ paused, intervalMs, lastTick, nextTickAt, breaker, passRunning, now }) {
  return {
    paused: !!paused,
    intervalS: Math.round(intervalMs / 1000),
    passRunning: !!passRunning,
    breaker: breaker ?? "CLOSED",
    // #91: surface WHY the last pass failed. The daemon already records `error`; omitting it here meant a
    // failing pass showed as { atS, ok:false } with the reason one field away and hidden — and `status` is
    // the first (often only) thing anyone checks when the loop looks healthy but nothing is moving.
    lastTick: lastTick
      ? { atS: Math.round(lastTick.at / 1000), ok: !!lastTick.ok, ...(lastTick.error ? { error: lastTick.error } : {}) }
      : null,
    nextTickInS: nextTickAt ? Math.max(0, Math.round((nextTickAt - now) / 1000)) : null,
  };
}

/** Map an activity-map entry to the board's {state, last} for a card that is NOT currently in-flight. */
function overlayFor(e) {
  if (e.event === "reconcile") {
    if (e.outcome === "routed") return { state: "advanced", last: e.detail ?? "routed" };
    if (e.outcome === "act_failed") {
      const transient = typeof e.detail === "string" && e.detail.endsWith("transient");
      return { state: transient ? "retrying" : "ESCALATED", last: e.detail ?? "act_failed" };
    }
    return { state: e.outcome ?? "reconcile", last: e.detail ?? e.outcome ?? "" };
  }
  if (e.event === "sync") return { state: e.outcome === "escalate" ? "ESCALATED" : (e.outcome ?? "sync"), last: e.detail ?? "" };
  if (e.event === "skipped") return { state: "skipped", last: e.detail ?? "" };
  return { state: e.event ?? "?", last: e.detail ?? "" }; // lone "dispatched" that's no longer in-flight
}

/**
 * Assemble the live status board from LOCAL state only (no board API): in-flight cards from the
 * dispatch manifest, overlaid with recently-resolved/escalated cards from the activity map.
 * In-flight first (oldest first), then resolved (newest first). Row: {cardId, role, state, ageS, last}.
 */
export function assembleBoard({ activityMap, manifestContent, now, staleS }) {
  const inflight = inflightRows(manifestContent, now, staleS);
  const inflightIds = new Set(inflight.map((r) => r.cardId));
  const rows = inflight
    .slice()
    .sort((a, b) => (b.ageS ?? 0) - (a.ageS ?? 0)) // oldest in-flight first
    .map((r) => ({ cardId: r.cardId, role: r.role ?? "-", state: "in-flight", ageS: r.ageS, last: "dispatched" }));

  const resolved = [];
  for (const [cardId, e] of activityMap ?? new Map()) {
    if (inflightIds.has(cardId)) continue; // in-flight row wins
    const { state, last } = overlayFor(e);
    resolved.push({ cardId, role: e.role ?? "-", state, ageS: Math.round((now - (e.at ?? now)) / 1000), last, _at: e.at ?? 0 });
  }
  resolved.sort((a, b) => b._at - a._at); // newest resolved first
  for (const r of resolved) { delete r._at; rows.push(r); }
  return rows;
}
