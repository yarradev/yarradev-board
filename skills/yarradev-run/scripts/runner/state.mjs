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
    lastTick: lastTick ? { atS: Math.round(lastTick.at / 1000), ok: !!lastTick.ok } : null,
    nextTickInS: nextTickAt ? Math.max(0, Math.round((nextTickAt - now) / 1000)) : null,
  };
}
