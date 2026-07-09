import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePassActivity, applyEvents, pruneActivity } from "../skills/yarradev-run/scripts/runner/pass-activity.mjs";

const AT = 1000;

test("parsePassActivity: dispatch line → one dispatched event per card", () => {
  const line = JSON.stringify({ phase: "dispatch", dispatched: [
    { role: "designer", cardId: "c1", to: "dev", state: "spec", promptFile: "/p", verdictPath: "/v" },
  ], skipped: [{ cardId: "c9", reason: "claim 409: fenced" }] });
  const events = parsePassActivity(line, AT);
  assert.deepEqual(events.find((e) => e.cardId === "c1"), {
    cardId: "c1", role: "designer", state: "spec", to: "dev", event: "dispatched", outcome: null, detail: null, at: AT,
  });
  const s = events.find((e) => e.cardId === "c9");
  assert.equal(s.event, "skipped");
  assert.equal(s.detail, "claim 409: fenced");
});

test("parsePassActivity: reconcile routed → carries the edge in detail", () => {
  const line = JSON.stringify({ phase: "reconcile", cardId: "c3", outcome: "routed", state: "dev", to: "test" });
  const [e] = parsePassActivity(line, AT);
  assert.equal(e.event, "reconcile");
  assert.equal(e.outcome, "routed");
  assert.equal(e.detail, "dev→test");
});

test("parsePassActivity: reconcile act_failed → detail flags transient vs deterministic", () => {
  const transient = JSON.stringify({ phase: "reconcile", cardId: "c4", outcome: "act_failed", state: "dev", to: "test", actFailed: { script: "link-pr.mjs", result: { status: 429 } } });
  const deterministic = JSON.stringify({ phase: "reconcile", cardId: "c5", outcome: "act_failed", state: "dev", to: "test", actFailed: { script: "link-pr.mjs", result: { status: 422 } } });
  assert.equal(parsePassActivity(transient, AT)[0].detail, "429 transient");
  assert.equal(parsePassActivity(deterministic, AT)[0].detail, "422 parked");
});

test("parsePassActivity: sync line → sync event keyed by id; malformed lines skipped", () => {
  const stdout = [
    "not json",
    JSON.stringify({ phase: "sync", kind: "escalate", id: "c7" }),
    "{ broken",
  ].join("\n");
  const events = parsePassActivity(stdout, AT);
  assert.equal(events.length, 1);
  assert.equal(events[0].cardId, "c7");
  assert.equal(events[0].event, "sync");
  assert.equal(events[0].outcome, "escalate");
});

test("parsePassActivity: pass-level 'action:skipped' dispatch line yields no per-card event", () => {
  const line = JSON.stringify({ phase: "dispatch", action: "skipped", reason: "at-capacity" });
  assert.deepEqual(parsePassActivity(line, AT), []);
});

test("applyEvents: last event per card wins", () => {
  const m = new Map();
  applyEvents(m, [{ cardId: "c1", event: "dispatched", at: 1 }]);
  applyEvents(m, [{ cardId: "c1", event: "reconcile", outcome: "routed", at: 2 }]);
  assert.equal(m.get("c1").event, "reconcile");
});

test("pruneActivity: drops entries older than ttl, then LRU-caps", () => {
  const m = new Map();
  for (let i = 0; i < 5; i++) m.set("c" + i, { cardId: "c" + i, at: 1600 + i });
  m.set("old", { cardId: "old", at: 1 });
  pruneActivity(m, 2000, { ttlMs: 500, cap: 3 });
  assert.ok(!m.has("old"), "old (ttl-expired) dropped");
  assert.equal(m.size, 3, "capped to 3");
  assert.ok(m.has("c4") && m.has("c3") && m.has("c2"), "keeps the newest by at");
});
