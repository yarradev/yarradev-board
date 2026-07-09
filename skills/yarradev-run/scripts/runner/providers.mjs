// skills/yarradev-run/scripts/runner/providers.mjs
import { readFileSync as fsRead, existsSync as fsExists } from "node:fs";
import { join } from "node:path";

export function readBreaker(stateDir, { readFileSync = fsRead, existsSync = fsExists } = {}) {
  const p = join(stateDir, "dispatch-breaker.json");
  try {
    if (!existsSync(p)) return "CLOSED";
    const s = JSON.parse(readFileSync(p, "utf8"))?.state;
    return s === "OPEN" || s === "HALF_OPEN" ? s : "CLOSED";
  } catch { return "CLOSED"; }
}

export function computeNextTickAt(lastTick, intervalMs) {
  return lastTick?.at != null ? lastTick.at + intervalMs : null;
}

export function latestEntryForCard(manifestContent, cardId) {
  let latest = null;
  for (const line of (manifestContent ?? "").split("\n")) {
    const t = line.trim(); if (!t) continue;
    let e; try { e = JSON.parse(t); } catch { continue; }
    if (e && String(e.cardId) === String(cardId)) latest = e; // last wins
  }
  return latest;
}

export function readVerdict(manifestContent, cardId, { readFileSync = fsRead, existsSync = fsExists } = {}) {
  const e = latestEntryForCard(manifestContent, cardId);
  if (!e?.verdictPath || !existsSync(e.verdictPath)) return "";
  try { return readFileSync(e.verdictPath, "utf8"); } catch { return ""; }
}
