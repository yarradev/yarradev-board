// test/runner-providers.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readBreaker, computeNextTickAt, latestEntryForCard, readVerdict } from "../skills/yarradev-run/scripts/runner/providers.mjs";
import { explainCard, attentionCards, retryCard } from "../skills/yarradev-run/scripts/runner/providers.mjs";

test("readBreaker parses state; defaults CLOSED when absent/corrupt", () => {
  const ok = { existsSync: () => true, readFileSync: () => JSON.stringify({ state: "OPEN", breakerUntil: 5 }) };
  assert.equal(readBreaker("/s", ok), "OPEN");
  assert.equal(readBreaker("/s", { existsSync: () => false, readFileSync: () => "" }), "CLOSED");
  assert.equal(readBreaker("/s", { existsSync: () => true, readFileSync: () => "not json" }), "CLOSED");
});

test("computeNextTickAt adds interval to last tick, else null", () => {
  assert.equal(computeNextTickAt({ at: 1000 }, 300), 1300);
  assert.equal(computeNextTickAt(null, 300), null);
});

test("latestEntryForCard returns the newest matching entry, tolerates malformed lines", () => {
  const m = [
    JSON.stringify({ status: "pending", cardId: "c1", verdictPath: "/v/a", role: "developer", dispatchedAt: "t1" }),
    "GARBAGE",
    JSON.stringify({ status: "done", cardId: "c1", verdictPath: "/v/b", role: "developer", completedAt: "t2" }),
    JSON.stringify({ status: "pending", cardId: "c2", verdictPath: "/v/c" }),
  ].join("\n");
  assert.equal(latestEntryForCard(m, "c1").verdictPath, "/v/b");
  assert.equal(latestEntryForCard(m, "cX"), null);
});

test("readVerdict reads the newest entry's verdictPath", () => {
  const m = JSON.stringify({ status: "pending", cardId: "c1", verdictPath: "/v/a" });
  const deps = { existsSync: (p) => p === "/v/a", readFileSync: (p) => (p === "/v/a" ? "hello log" : "") };
  assert.equal(readVerdict(m, "c1", deps), "hello log");
  assert.equal(readVerdict(m, "absent", deps), "");
});

function fakeClient(cards) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const calls = { clearLease: [] };
  return {
    calls,
    async getEnriched(id) { return byId.get(id) ?? null; },
    async listCards() { return cards.map((c) => ({ id: c.id, state: c.state })); },
    async clearLease(id, gen) { calls.clearLease.push([id, gen]); return { ok: true }; },
  };
}

test("explainCard merges board + local + breaker", async () => {
  const client = fakeClient([{ id: "c1", state: "dev", deps_resolved: true, current_gen: 7, ci_rollup: "failure" }]);
  const manifest = JSON.stringify({ status: "pending", cardId: "c1", verdictPath: "/v/a", role: "developer", dispatchedAt: "t1", gen: 7 });
  const out = await explainCard("c1", { client, manifestContent: manifest, stateDir: "/s", deps: { existsSync: () => false, readFileSync: () => "" } });
  assert.equal(out.cardId, "c1");
  assert.equal(out.board.state, "dev");
  assert.equal(out.board.ci_rollup, "failure");
  assert.equal(out.local.role, "developer");
  assert.equal(out.local.status, "pending");
  assert.equal(out.breaker, "CLOSED");
});

test("explainCard tolerates an unknown card (board null)", async () => {
  const out = await explainCard("cX", { client: fakeClient([]), manifestContent: "", stateDir: "/s", deps: { existsSync: () => false, readFileSync: () => "" } });
  assert.equal(out.board, null);
  assert.equal(out.local, null);
});

test("attentionCards selects only human-attention cards with reasons", async () => {
  const client = fakeClient([
    { id: "a", state: "dev", veto_held: false, hold_open: false, blocked: false, open_questions: [], escalated: false },
    { id: "b", state: "test", veto_held: true },
    { id: "c", state: "spec", blocked: true, open_questions: [{ deadline_ts: 1 }] },
    { id: "d", state: "done", escalated: true },
  ]);
  const rows = await attentionCards({ client });
  assert.deepEqual(rows.map((r) => r.cardId).sort(), ["b", "c", "d"]);
  assert.ok(rows.find((r) => r.cardId === "b").reasons.includes("veto_held"));
  assert.ok(rows.find((r) => r.cardId === "c").reasons.includes("open_question"));
});

test("retryCard clears the lease at current_gen then ticks", async () => {
  const client = fakeClient([{ id: "c1", current_gen: 9 }]);
  let ticked = 0;
  const out = await retryCard("c1", { client, requestTick: () => { ticked++; } });
  assert.deepEqual(out, { ok: true, cardId: "c1", clearedGen: 9 });
  assert.deepEqual(client.calls.clearLease, [["c1", 9]]);
  assert.equal(ticked, 1);
});

test("retryCard on an unknown card ticks but reports no gen cleared", async () => {
  const client = fakeClient([]);
  let ticked = 0;
  const out = await retryCard("cX", { client, requestTick: () => { ticked++; } });
  assert.deepEqual(out, { ok: true, cardId: "cX", clearedGen: null });
  assert.equal(client.calls.clearLease.length, 0);
  assert.equal(ticked, 1);
});
