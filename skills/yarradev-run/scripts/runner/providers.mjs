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

export async function explainCard(cardId, { client, manifestContent, stateDir, deps }) {
  const board = (await client.getEnriched(cardId)) ?? null;
  const e = latestEntryForCard(manifestContent, cardId);
  const local = e
    ? { role: e.role ?? null, status: e.status ?? null, gen: e.gen ?? null, verdictPath: e.verdictPath ?? null, at: e.dispatchedAt ?? e.completedAt ?? null }
    : null;
  return { cardId: String(cardId), board, local, breaker: readBreaker(stateDir, deps) };
}

export async function attentionCards({ client }) {
  const summaries = await client.listCards();
  const rows = [];
  for (const s of summaries ?? []) {
    const c = (await client.getEnriched(s.id)) ?? {};
    const reasons = [];
    if (c.veto_held) reasons.push("veto_held");
    if (c.hold_open) reasons.push("hold_open");
    if (c.blocked && (c.open_questions?.length ?? 0) > 0) reasons.push("open_question");
    if (c.escalated) reasons.push("escalated");
    if (reasons.length) rows.push({ cardId: String(s.id), state: c.state ?? s.state ?? null, reasons });
  }
  return rows;
}

export async function retryCard(cardId, { client, requestTick }) {
  const c = await client.getEnriched(cardId);
  let clearedGen = null;
  if (c && c.current_gen != null) { clearedGen = c.current_gen; await client.clearLease(cardId, clearedGen); }
  requestTick();
  return { ok: true, cardId: String(cardId), clearedGen };
}
