// skills/yarradev-run/scripts/runner/render-board.mjs — pure table renderer for the status board.
const COLORS = { "in-flight": "\x1b[36m", advanced: "\x1b[32m", ESCALATED: "\x1b[31m", retrying: "\x1b[33m" };
const RESET = "\x1b[0m";
const COLS = [
  { key: "cardId", head: "CARD" },
  { key: "role", head: "ROLE" },
  { key: "state", head: "STATE" },
  { key: "age", head: "AGE" },
  { key: "last", head: "LAST" },
];

const ageStr = (ageS) => (ageS == null ? "-" : `${ageS}s`);

/**
 * Render board rows as an aligned text table. Pure. `color:true` wraps the STATE token in ANSI.
 * @param {Array<{cardId,role,state,ageS,last}>} rows
 * @param {{color?: boolean}} [opts]
 * @returns {string}
 */
export function renderBoard(rows, { color = false } = {}) {
  if (!rows || rows.length === 0) return "(idle — nothing in flight)";
  const cells = rows.map((r) => ({ cardId: String(r.cardId), role: String(r.role ?? "-"), state: String(r.state ?? "?"), age: ageStr(r.ageS), last: String(r.last ?? "") }));
  const width = {};
  for (const c of COLS) width[c.key] = Math.max(c.head.length, ...cells.map((x) => x[c.key].length));
  const pad = (s, w) => s + " ".repeat(Math.max(0, w - s.length));
  const header = COLS.map((c) => pad(c.head, width[c.key])).join("  ").trimEnd();
  const body = cells.map((x) =>
    COLS.map((c) => {
      const padded = pad(x[c.key], width[c.key]);
      if (color && c.key === "state" && COLORS[x.state]) return COLORS[x.state] + padded + RESET;
      return padded;
    }).join("  ").trimEnd(),
  );
  return [header, ...body].join("\n");
}
