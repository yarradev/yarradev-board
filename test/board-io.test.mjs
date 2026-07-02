/*
 * Live HTTP-rail test for the deterministic board scripts (no LLM). OPT-IN: set YDB_IT=1 and point
 * it at a booted, seeded local board (config/board.example.json defaults to acme:flow @ :8802; the
 * orchestrator identity in YDB_TOKEN must have CREATE/CLAIM/MOVE/CLEAR_LEASE caps — see README runbook).
 * Without YDB_IT it skips, so `npm test` stays green offline. Importing plugin-io here also smoke-loads
 * the vendored-core BoardClient wiring (makeClient → ./vendor/core.mjs).
 *
 * Drives the vendored orchestrator-core client. Its methods return an AppendResult
 * ({ outcome, status, seq, applied, dispatch?, item?, ... }) rather than the old plugin client's
 * normalized { ok, gen, ... }, so assertions read outcome/status and derive gen via genOf().
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeClient, genOf } from "../skills/yarradev-run/scripts/plugin-io.mjs";

const skip = process.env.YDB_IT === "1" ? false : "set YDB_IT=1 + boot the seeded local board to run the live rail test";

test("board rail: CREATE → list → claim → move → stale-gen 409 → bad-to 422 → clear-lease", { skip }, async () => {
  const client = makeClient(); // apiBase/doName from config; token from YDB_TOKEN
  const id = `card-it-${Date.now()}`;

  const created = await client.act({ type: "CREATE", item_id: id, data: { state: "spec", title: "rail test" } });
  assert.equal(created.outcome, "committed", `CREATE failed: ${JSON.stringify(created)}`);

  // GET /cards returns { items, nextAfterId }; core types listCards() as ItemSnapshot[] and returns the
  // body verbatim, so accept either shape.
  const listed = await client.listCards();
  const cards = Array.isArray(listed) ? listed : (listed?.items ?? []);
  const c = cards.find((x) => x.id === id);
  assert.ok(c, "created card not listed");
  assert.equal(c.state, "spec");
  assert.equal(c.title, "rail test", "title should round-trip from CREATE into the snapshot");

  const claim = await client.claim(id, "designer", 1800);
  assert.equal(claim.outcome, "committed", `claim failed: ${JSON.stringify(claim)}`);
  const gen = genOf(claim);
  assert.ok(gen >= 1, `expected gen>=1, got ${gen}`);

  const mv = await client.move(id, gen, "dev");
  assert.equal(mv.outcome, "committed", `move spec->dev failed: ${JSON.stringify(mv)}`);

  // The real loop clears the lease after every stage; do the same before the next claim
  // (a back-to-back claim while the lease is still active is correctly fenced — single-owner).
  const cl1 = await client.clearLease(id, gen);
  assert.equal(cl1.outcome, "committed", `clear-lease after move failed: ${JSON.stringify(cl1)}`);

  // fresh lease in dev for the negative cases
  const claim2 = await client.claim(id, "developer", 1800);
  assert.equal(claim2.outcome, "committed", `re-claim failed: ${JSON.stringify(claim2)}`);
  const gen2 = genOf(claim2);

  const stale = await client.move(id, gen2 - 1, "test");
  assert.equal(stale.status, 409, `expected 409 fenced, got ${stale.status}/${stale.outcome}`);
  assert.notEqual(stale.outcome, "committed");

  const bad = await client.move(id, gen2, "nonsense");
  assert.notEqual(bad.outcome, "committed");
  assert.ok(bad.status === 422 || bad.status === 409, `expected 422/409 for bad target, got ${bad.status}/${bad.outcome}`);

  const cl = await client.clearLease(id, gen2);
  assert.equal(cl.outcome, "committed", `clear-lease failed: ${JSON.stringify(cl)}`);
});
