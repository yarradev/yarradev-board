/*
 * Live HTTP-rail test for the deterministic board scripts (no LLM). OPT-IN: set YDB_IT=1 and point
 * it at a booted, seeded local board (config/board.example.json defaults to acme:flow @ :8802; the
 * orchestrator identity in YDB_TOKEN must have CREATE/CLAIM/MOVE/CLEAR_LEASE caps — see README runbook).
 * Without YDB_IT it skips, so `npm test` stays green offline. Importing lib.mjs here also smoke-loads it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BoardClient } from "../skills/yarradev-board-run/scripts/lib.mjs";

const skip = process.env.YDB_IT === "1" ? false : "set YDB_IT=1 + boot the seeded local board to run the live rail test";

test("board rail: CREATE → list → claim → move → stale-gen 409 → bad-to 422 → clear-lease", { skip }, async () => {
  const client = new BoardClient(); // apiBase/doName from config; token from YDB_TOKEN
  const id = `card-it-${Date.now()}`;

  const created = await client.act({ type: "CREATE", item_id: id, data: { state: "spec", title: "rail test" } });
  assert.equal(created.outcome, "committed", `CREATE failed: ${JSON.stringify(created)}`);

  const cards = await client.listCards();
  const c = cards.find((x) => x.id === id);
  assert.ok(c, "created card not listed");
  assert.equal(c.state, "spec");

  const claim = await client.claim(id, "designer", 1800);
  assert.equal(claim.ok, true, `claim failed: ${JSON.stringify(claim)}`);
  assert.ok(claim.gen >= 1, `expected gen>=1, got ${claim.gen}`);

  const mv = await client.move(id, claim.gen, "dev");
  assert.equal(mv.ok, true, `move spec->dev failed: ${JSON.stringify(mv)}`);

  // fresh lease in dev for the negative cases
  const claim2 = await client.claim(id, "developer", 1800);
  assert.equal(claim2.ok, true, `re-claim failed: ${JSON.stringify(claim2)}`);

  const stale = await client.move(id, claim2.gen - 1, "test");
  assert.equal(stale.status, 409, `expected 409 fenced, got ${stale.status}/${stale.outcome}`);
  assert.equal(stale.ok, false);

  const bad = await client.move(id, claim2.gen, "nonsense");
  assert.equal(bad.ok, false);
  assert.ok(bad.status === 422 || bad.status === 409, `expected 422/409 for bad target, got ${bad.status}/${bad.outcome}`);

  const cl = await client.clearLease(id, claim2.gen);
  assert.equal(cl.ok, true, `clear-lease failed: ${JSON.stringify(cl)}`);
});
