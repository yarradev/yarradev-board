#!/usr/bin/env node
/*
 * release.mjs <id> — autonomously promote a validated card to PRODUCTION by posting a RELEASE act at the
 * card's CURRENT gen (CLAIM-free, like promote.mjs — the gen-fenced RELEASE rides the current gen; a CLAIM
 * bump would invalidate the gen-stamped facts the board's auto_release floor folds).
 *
 * SECURITY-CRITICAL — FAIL CLOSED. Production is human-gated by default. This path only advances a card
 * when the board is configured for autonomous release AND the token carries the `board:release` grant AND
 * the `auto_release` floor is green (no open veto/hold, CI green, staging smoke green). Every other case
 * MUST NOT promote:
 *   - a token LACKING `board:release` → the board denies the RELEASE with 403 → core maps it to
 *     outcome "unauthorized" → emit() exits 1 → the card stays put; the loop falls back to the human-GO
 *     wait. Agents cannot self-grant a release.
 *   - the auto_release floor not met → 422 gate_blocked (blocked_by ⊇ auto_release) → emit() exits 1.
 * Only outcome "committed" advances the card to prod. Prints { ok, blocked_by, status, outcome }; exit 0
 * on committed, 1 otherwise.
 */
import { makeClient, emit } from "./plugin-io.mjs";

/**
 * Post a RELEASE (autonomous prod promote) at the card's current gen. Fail-closed: only a committed
 * outcome returns 0; a 403 (unauthorized) or 422 (gate_blocked) returns non-zero and the card is NOT
 * promoted.
 * @param {{ getEnriched: (id:string)=>Promise<any>, act: (a:object)=>Promise<any> }} client
 * @param {string} id card id
 * @returns {Promise<number>} exit code (0 committed, 1 otherwise)
 */
export async function runRelease(client, id) {
  // Read the card's CURRENT gen (a RELEASE rides it — no CLAIM, so gen-stamped auto_release facts stay valid).
  const card = await client.getEnriched(id);
  if (!card || card.current_gen == null) {
    process.stdout.write(JSON.stringify({ ok: false, error: "no such card" }) + "\n");
    return 1;
  }
  // The board's RELEASE fold enforces the board:release scope (→403) and the auto_release gate (→422
  // blocked_by ⊇ auto_release). emit() exits non-zero on anything but a committed outcome — fail-closed.
  const r = await client.act({ type: "RELEASE", item_id: id, gen: card.current_gen, data: { to: "prod" } });
  return emit(r, { blocked_by: r?.blocked_by });
}

// CLI: only execute when invoked directly (`node release.mjs <id>`), NOT on import — the unit test imports
// runRelease and injects a fake client, and must not drive a real board.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [id] = process.argv.slice(2);
  if (!id) {
    console.error("usage: release.mjs <id>");
    process.exit(2);
  }
  // Posted under the releaser identity (YDB_TOKEN_RELEASER); the board:release grant lives on that token.
  const code = await runRelease(makeClient({ role: "releaser" }), id);
  process.exit(code);
}
