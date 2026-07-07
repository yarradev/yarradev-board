#!/usr/bin/env node
/*
 * build-prompt.mjs <role> <cardId> [--to <to>] [--out <path>] [--extras-file <path>]
 *
 * Composes + writes the dispatch prompt file for a role subagent, so the conductor doesn't hand-assemble it
 * (GH A5). Two wins:
 *   1. Kills the shell-escaping footgun — the file is written with Node fs.writeFileSync, not a heredoc/echo,
 *      so special chars in titles/notes can't break shell quoting.
 *   2. Guarantees forward-context (GH #18) — the card's `notes[]` (prior-stage rationale: designer plan,
 *      reviewer findings) are fetched and included automatically, so the next owner reads them forward
 *      instead of the conductor having to remember to forward them each time.
 *
 * Fetches the card (getEnriched → state, title, notes[]) and reads config (doName, lifecycle for the
 * default `to`). Writes the dispatch context + notes (+ optional role-specific extras) to the prompt file
 * and prints its path — feed that to dispatch-and-wait.mjs:
 *   P=$(node $S/build-prompt.mjs <role> <cardId>); V=$(node $S/dispatch-and-wait.mjs <role> <cardId> "$P")
 *
 * Scope: the WORKER dispatch prompt (work/respawn/reclaim — the common path where notes[] matter). Advisor
 * prompts (which need repo/branch/head/watch_paths, not notes) are not composed here yet — pass them via
 * --extras-file or extend this helper.
 *
 * The file contains NO board token: the helper uses the token only for the getEnriched fetch and writes
 * only card data. (dispatch-and-wait.mjs additionally strips YDB_TOKEN* from the subagent env, GH #25.)
 */
import { makeClient, loadConfig } from "./plugin-io.mjs";
import { writeFileSync, readFileSync } from "node:fs";

/** Render a single note defensively — note.mjs posts data:{text}, but tolerate a raw string or other shape. */
function noteBody(n) {
  if (typeof n === "string") return n;
  if (n && typeof n.text === "string") return n.text;
  try {
    return JSON.stringify(n);
  } catch {
    return String(n);
  }
}

/**
 * Pure prompt composer (testable with a fake card — no board, no fs).
 * @param {{role: string, card: any, doName: string, to: string, extras?: string}} ctx
 * @returns {string} the prompt body
 */
export function composePrompt({ role, card, doName, to, extras }) {
  const c = card ?? {};
  const lines = [];
  lines.push("=== Dispatch context ===");
  lines.push(`doName: ${doName ?? ""}`);
  lines.push(`cardId: ${c.id ?? ""}`);
  lines.push(`state: ${c.state ?? ""}`);
  lines.push(`to: ${to ?? ""}`);
  lines.push(`role: ${role ?? ""}`);
  lines.push(`title: ${c.title ?? ""}`);
  lines.push("");
  const notes = Array.isArray(c.notes) ? c.notes : [];
  if (notes.length) {
    lines.push("=== Prior-stage context (notes — read forward; do not re-derive work already done) ===");
    for (const n of notes) {
      lines.push("- " + noteBody(n).trim());
      lines.push("");
    }
  }
  if (extras != null && extras !== "") {
    lines.push("=== Role-specific ===");
    lines.push(String(extras).trim());
    lines.push("");
  }
  return lines.join("\n");
}

// CLI: only execute when invoked directly — the unit test imports composePrompt and must not hit the board.
if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = { positional: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--to") opts.to = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--extras-file") opts.extrasFile = argv[++i];
    else opts.positional.push(a);
  }
  const [role, cardId] = opts.positional;
  if (!role || !cardId) {
    console.error("usage: build-prompt.mjs <role> <cardId> [--to <to>] [--out <path>] [--extras-file <path>]");
    process.exit(2);
  }
  const cfg = loadConfig();
  const card = await makeClient({ role: "orchestrator" }).getEnriched(cardId);
  const to = opts.to ?? cfg.lifecycle?.[card?.state]?.to;
  const extras = opts.extrasFile ? readFileSync(opts.extrasFile, "utf8") : undefined;
  const out = opts.out ?? `/tmp/yarradev-prompt-${cardId}.txt`;
  writeFileSync(out, composePrompt({ role, card, doName: cfg.doName, to, extras }));
  process.stdout.write(out + "\n");
  process.exit(0);
}
