// skills/yarradev-run/scripts/runner/pass-activity.mjs
// Parse a pass child's stdout (the {phase:...} JSON lines) into per-card activity events, and
// maintain a bounded, TTL'd activity map the status board reads. All pure/clock-free (caller
// supplies `at`/`now`).
import { isTransientActFailure } from "../pass.mjs";

/** Label an act_failed reconcile line's detail: "<status> transient" | "<status> parked". */
function actFailedDetail(j) {
  const result = j?.actFailed?.result ?? null;
  const status = result?.status;
  const transient = isTransientActFailure(result);
  const kind = transient ? "transient" : "parked";
  return status != null ? `${status} ${kind}` : kind;
}

/**
 * Fold a pass's stdout into per-card events. Tolerates non-JSON / malformed lines (skips them).
 * @param {string} stdout
 * @param {number} at epoch ms stamped on every event (caller-supplied, clock-free)
 * @returns {Array<object>}
 */
export function parsePassActivity(stdout, at) {
  const events = [];
  for (const line of (stdout ?? "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let j;
    try { j = JSON.parse(t); } catch { continue; }
    if (!j || typeof j !== "object") continue;

    if (j.phase === "dispatch") {
      for (const d of Array.isArray(j.dispatched) ? j.dispatched : []) {
        if (d?.cardId == null) continue;
        events.push({ cardId: String(d.cardId), role: d.role ?? null, state: d.state ?? null, to: d.to ?? null, event: "dispatched", outcome: null, detail: null, at });
      }
      for (const s of Array.isArray(j.skipped) ? j.skipped : []) {
        if (s?.cardId == null) continue;
        events.push({ cardId: String(s.cardId), role: null, state: null, to: null, event: "skipped", outcome: "skipped", detail: s.reason ?? null, at });
      }
      // pass-level {action:"skipped"} lines (breaker-open / at-capacity) carry no cardId → ignored
    } else if (j.phase === "reconcile") {
      if (j.cardId == null) continue;
      const edge = j.state != null && j.to != null ? `${j.state}→${j.to}` : null;
      const detail = j.outcome === "act_failed" ? actFailedDetail(j) : edge;
      events.push({ cardId: String(j.cardId), role: null, state: j.state ?? null, to: j.to ?? null, event: "reconcile", outcome: j.outcome ?? null, detail, at });
    } else if (j.phase === "sync") {
      if (j.id == null) continue;
      events.push({ cardId: String(j.id), role: null, state: null, to: null, event: "sync", outcome: j.kind ?? null, detail: null, at });
    }
  }
  return events;
}

/** Fold events into the map; last event per card wins (events are in emission order). */
export function applyEvents(map, events) {
  for (const e of events ?? []) map.set(e.cardId, e);
}

/** Drop entries older than ttlMs, then LRU-cap by `at` (oldest dropped first). Mutates. */
export function pruneActivity(map, now, { ttlMs = 600_000, cap = 50 } = {}) {
  for (const [k, e] of map) {
    if (now - (e?.at ?? 0) > ttlMs) map.delete(k);
  }
  if (map.size > cap) {
    const sorted = [...map.entries()].sort((a, b) => (a[1]?.at ?? 0) - (b[1]?.at ?? 0));
    const toDelete = map.size - cap;
    for (let i = 0; i < toDelete; i++) map.delete(sorted[i][0]);
  }
}
