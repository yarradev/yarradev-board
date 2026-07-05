/*
 * reconcile-spawn.test.mjs — Phase B / B4 (auto-raised-bug-cards §6). Pins reconcileCardSpawn: the
 * conductor's drain of a card's derived_json.pending_spawn (posted out-of-lifecycle by the
 * write:advice review-bridge, B1-B3) into bug cards. Mirrors the in-lifecycle A7 spawn branch's
 * semantics — deterministic id, existence pre-check (dedup), CREATE then NOTE, stop-on-error, cap — but
 * with a fake client (no network), like note.test.mjs/release.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileCardSpawn, SPAWN_CAP_PER_CARD } from "../skills/yarradev-run/scripts/reconcile-spawn.mjs";

// A stable, injectable stand-in for runFingerprint: deterministic, no crypto, easy to reason about.
const idFor = (entry) => `bug-${entry.repo}:${entry.file}:${entry.summary}`;
const fakeFingerprint = async (repo, file, summary) => idFor({ repo, file, summary });

/** A fake BoardClient: getEnriched keyed by a mutable map, create/act append to logs. */
function fakeClient({ existing = {} } = {}) {
  const cards = new Map(Object.entries(existing));
  const createCalls = [];
  const actCalls = [];
  return {
    cards,
    createCalls,
    actCalls,
    async getEnriched(id) {
      return cards.get(id) ?? null;
    },
    async create(id, data) {
      createCalls.push({ id, data });
      cards.set(id, { id, notes: [], ...data }); // reflect the mint so a later getEnriched sees it
      return { outcome: "committed", status: 202, applied: true };
    },
    async act(a) {
      actCalls.push(a);
      if (a.type === "NOTE") {
        const card = cards.get(a.item_id);
        if (card) card.notes = [...(card.notes ?? []), { body: a.data.text }];
      }
      return { outcome: "committed", status: 202, applied: true };
    },
  };
}

const entry = (over = {}) => ({ title: "Off-by-one in loop", file: "src/x.ts", summary: "off by one", repo: "o/r", ...over });

test("absent entry: mints CREATE(type:bug,state:dev,parent) then NOTE the repro", async () => {
  const client = fakeClient();
  const e = entry({ note: "repro: run x" });
  const id = idFor(e);
  const result = await reconcileCardSpawn(client, "card-1", [e], { fingerprint: fakeFingerprint });

  assert.deepEqual(result, { created: [id], noted: [id], skipped: [], deferred: 0 });
  assert.equal(client.createCalls.length, 1);
  assert.deepEqual(client.createCalls[0], { id, data: { type: "bug", title: e.title, state: "dev", parent_id: "card-1" } });
  assert.equal(client.actCalls.length, 1);
  assert.deepEqual(client.actCalls[0], { type: "NOTE", item_id: id, data: { text: "repro: run x" } });
});

test("absent entry with no note: CREATE only, no NOTE posted", async () => {
  const client = fakeClient();
  const e = entry();
  const id = idFor(e);
  const result = await reconcileCardSpawn(client, "card-1", [e], { fingerprint: fakeFingerprint });

  assert.deepEqual(result, { created: [id], noted: [], skipped: [], deferred: 0 });
  assert.equal(client.actCalls.length, 0, "no blank NOTE posted");
});

test("already-filed entry (card exists, notes non-empty): SKIP — no CREATE, no NOTE (idempotent re-observe)", async () => {
  const e = entry({ note: "repro" });
  const id = idFor(e);
  const client = fakeClient({ existing: { [id]: { id, notes: [{ body: "repro" }] } } });
  const result = await reconcileCardSpawn(client, "card-1", [e], { fingerprint: fakeFingerprint });

  assert.deepEqual(result, { created: [], noted: [], skipped: [id], deferred: 0 });
  assert.equal(client.createCalls.length, 0);
  assert.equal(client.actCalls.length, 0);
});

test("card exists but repro note never landed (empty notes[]): retry NOTE only, do NOT re-CREATE", async () => {
  const e = entry({ note: "repro: run x" });
  const id = idFor(e);
  const client = fakeClient({ existing: { [id]: { id, notes: [] } } });
  const result = await reconcileCardSpawn(client, "card-1", [e], { fingerprint: fakeFingerprint });

  assert.deepEqual(result, { created: [], noted: [id], skipped: [], deferred: 0 });
  assert.equal(client.createCalls.length, 0, "must not re-CREATE an existing card");
  assert.equal(client.actCalls.length, 1);
  assert.deepEqual(client.actCalls[0], { type: "NOTE", item_id: id, data: { text: "repro: run x" } });
});

test("card exists, no note requested: SKIP (nothing to attach)", async () => {
  const e = entry(); // no note
  const id = idFor(e);
  const client = fakeClient({ existing: { [id]: { id, notes: [] } } });
  const result = await reconcileCardSpawn(client, "card-1", [e], { fingerprint: fakeFingerprint });

  assert.deepEqual(result, { created: [], noted: [], skipped: [id], deferred: 0 });
  assert.equal(client.createCalls.length, 0);
  assert.equal(client.actCalls.length, 0);
});

test("idempotence: re-running over the SAME pending_spawn after a successful pass is a full no-op", async () => {
  const client = fakeClient();
  const e = entry({ note: "repro" });
  const first = await reconcileCardSpawn(client, "card-1", [e], { fingerprint: fakeFingerprint });
  assert.equal(first.created.length, 1);

  client.createCalls.length = 0;
  client.actCalls.length = 0;
  const second = await reconcileCardSpawn(client, "card-1", [e], { fingerprint: fakeFingerprint });
  assert.deepEqual(second.skipped, [idFor(e)]);
  assert.equal(client.createCalls.length, 0);
  assert.equal(client.actCalls.length, 0);
});

test("CREATE failure: stops issuing further spawn entries for this card this pass (not silently swallowed)", async () => {
  const client = fakeClient();
  client.create = async (id) => {
    client.createCalls.push({ id });
    return { outcome: "gate_blocked", status: 422, applied: false };
  };
  const e1 = entry({ file: "a.ts", summary: "bug a" });
  const e2 = entry({ file: "b.ts", summary: "bug b" });
  const result = await reconcileCardSpawn(client, "card-1", [e1, e2], { fingerprint: fakeFingerprint });

  assert.equal(result.created.length, 0);
  assert.ok(result.stoppedOnError);
  assert.equal(result.stoppedOnError.step, "create");
  assert.equal(client.createCalls.length, 1, "must stop after the first failure — never attempt entry 2");
});

test("cap bounds MUTATIONS per pass, not entries examined: already-filed entries don't count against it", async () => {
  // 25 entries: the first SPAWN_CAP_PER_CARD are already fully filed (cheap skips, don't count),
  // the rest are new. All should still get created in one pass since skips are free.
  const filed = Array.from({ length: SPAWN_CAP_PER_CARD }, (_, i) => entry({ file: `filed-${i}.ts`, summary: `filed ${i}` }));
  const fresh = Array.from({ length: 5 }, (_, i) => entry({ file: `fresh-${i}.ts`, summary: `fresh ${i}` }));
  const existing = Object.fromEntries(filed.map((e) => [idFor(e), { id: idFor(e), notes: [] }]));
  const client = fakeClient({ existing });

  const result = await reconcileCardSpawn(client, "card-1", [...filed, ...fresh], { fingerprint: fakeFingerprint });
  assert.equal(result.skipped.length, SPAWN_CAP_PER_CARD);
  assert.equal(result.created.length, 5, "fresh entries are NOT starved by the already-filed prefix");
  assert.equal(result.deferred, 0);
});

test("cap DOES bound new CREATE/NOTE work: entries beyond the cap are deferred (not dropped) to next pass", async () => {
  const entries = Array.from({ length: SPAWN_CAP_PER_CARD + 3 }, (_, i) => entry({ file: `e-${i}.ts`, summary: `e ${i}` }));
  const client = fakeClient();
  const result = await reconcileCardSpawn(client, "card-1", entries, { fingerprint: fakeFingerprint });

  assert.equal(result.created.length, SPAWN_CAP_PER_CARD, "exactly the cap's worth of CREATEs this pass");
  assert.equal(result.deferred, 3, "the remaining 3 are deferred to the next pass, not lost");
});
