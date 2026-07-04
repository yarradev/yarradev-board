#!/usr/bin/env node
/*
 * note.mjs <id> <text...> — post a NOTE fact (gen-exempt) recording free-form text on a card. This is
 * the live poster for the "advice.spawn" bug-raising primitive (Task A6): after SKILL.md's spawn branch
 * mints a bug card via create.mjs, it calls note.mjs to attach the finding's repro body (file:line,
 * failure_scenario, category, source — see spec §2/§3) so the spawned card carries context, not just a
 * bare title.
 *
 * Posted under the ORCHESTRATOR identity — the spawn primitive is role-agnostic (any advisor's `advice`
 * verdict may carry `spawn[]`, per spec §5), so the resulting NOTE is not attributed to the reviewing
 * role; the orchestrator is the one materializing it, exactly like create.mjs's bug-spawn CREATE.
 *
 * Prints { ok, status, outcome }. Exit 0 on committed, 1 otherwise, 2 on usage error.
 */
import { makeClient, emit } from "./plugin-io.mjs";

/**
 * Post a gen-exempt NOTE recording free-form text on a card.
 * @param {{ act: (a:object)=>Promise<any> }} client
 * @param {string} id card id
 * @param {string} text note body
 * @returns {Promise<number>} exit code (0 committed, 1 otherwise)
 */
export async function runNote(client, id, text) {
  const r = await client.act({ type: "NOTE", item_id: id, data: { text } });
  return emit(r, {});
}

// CLI: only execute when invoked directly (`node note.mjs <id> <text...>`), NOT on import — the unit
// test imports runNote and injects a fake client, and must not drive a real board.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [id, ...rest] = process.argv.slice(2);
  if (!id || rest.length === 0) {
    console.error("usage: note.mjs <id> <text...>");
    process.exit(2);
  }
  const code = await runNote(makeClient({ role: "orchestrator" }), id, rest.join(" "));
  process.exit(code);
}
