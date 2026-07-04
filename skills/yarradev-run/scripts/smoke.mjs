#!/usr/bin/env node
/*
 * smoke.mjs <id> <env> <state> — post a SMOKE fact recording the result of a post-deploy smoke run for an
 * environment (env ∈ {staging, prod}, state ∈ {success, red, …}). SMOKE is a gen-EXEMPT fact (no gen arg):
 * it records an observation, it does not advance the lifecycle, so it is not gen-fenced. The board folds
 * SMOKE into `staging_smoke` / `prod_smoke`, which the `auto_release` floor (staging) and the releaser's
 * prod-smoke policy read. Prints { ok, status, outcome }; exit 0 on committed, 1 otherwise.
 */
import { makeClient, emit } from "./plugin-io.mjs";

/**
 * Post a gen-exempt SMOKE fact folding smoke.staging / smoke.prod results.
 * @param {{ act: (a:object)=>Promise<any> }} client
 * @param {string} id card id
 * @param {string} env environment the smoke ran against (e.g. "staging" | "prod")
 * @param {string} state smoke result (e.g. "success" | "red")
 * @returns {Promise<number>} exit code (0 committed, 1 otherwise)
 */
export async function runSmoke(client, id, env, state) {
  const r = await client.act({ type: "SMOKE", item_id: id, data: { env, state } });
  return emit(r, {});
}

// CLI: only execute when invoked directly, NOT on import (unit tests inject a fake client).
if (import.meta.url === `file://${process.argv[1]}`) {
  const [id, env, state] = process.argv.slice(2);
  if (!id || !env || !state) {
    console.error("usage: smoke.mjs <id> <env> <state>");
    process.exit(2);
  }
  const code = await runSmoke(makeClient({ role: "releaser" }), id, env, state);
  process.exit(code);
}
