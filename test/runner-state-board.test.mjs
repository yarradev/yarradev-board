import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleBoard } from "../skills/yarradev-run/scripts/runner/state.mjs";

const NOW = 100_000;
const iso = (ms) => new Date(ms).toISOString();

test("assembleBoard: in-flight cards render as in-flight/dispatched with age from the manifest", () => {
  const manifest = JSON.stringify({ status: "pending", cardId: "c1", role: "designer", verdictPath: "/v1", dispatchedAt: iso(NOW - 12_000) });
  const rows = assembleBoard({ activityMap: new Map(), manifestContent: manifest, now: NOW, staleS: 7200 });
  assert.deepEqual(rows, [{ cardId: "c1", role: "designer", state: "in-flight", ageS: 12, last: "dispatched" }]);
});

test("assembleBoard: a resolved (advanced) card not in flight is overlaid from the activity map", () => {
  const activity = new Map([["c3", { cardId: "c3", role: null, state: "dev", to: "test", event: "reconcile", outcome: "routed", detail: "dev→test", at: NOW - 2000 }]]);
  const rows = assembleBoard({ activityMap: activity, manifestContent: "", now: NOW, staleS: 7200 });
  assert.deepEqual(rows, [{ cardId: "c3", role: "-", state: "advanced", ageS: 2, last: "dev→test" }]);
});

test("assembleBoard: transient act_failed → 'retrying'; deterministic → 'ESCALATED'; escalate sync → 'ESCALATED'", () => {
  const activity = new Map([
    ["t", { cardId: "t", role: null, event: "reconcile", outcome: "act_failed", detail: "429 transient", at: NOW - 1000 }],
    ["d", { cardId: "d", role: null, event: "reconcile", outcome: "act_failed", detail: "422 parked", at: NOW - 1000 }],
    ["e", { cardId: "e", role: null, event: "sync", outcome: "escalate", detail: null, at: NOW - 1000 }],
  ]);
  const rows = assembleBoard({ activityMap: activity, manifestContent: "", now: NOW, staleS: 7200 });
  const byId = Object.fromEntries(rows.map((r) => [r.cardId, r]));
  assert.equal(byId.t.state, "retrying");
  assert.equal(byId.d.state, "ESCALATED");
  assert.equal(byId.e.state, "ESCALATED");
});

test("assembleBoard: in-flight first (oldest first), then resolved (newest first); in-flight wins over a stale activity entry", () => {
  const manifest = [
    JSON.stringify({ status: "pending", cardId: "old", role: "developer", verdictPath: "/vo", dispatchedAt: iso(NOW - 30_000) }),
    JSON.stringify({ status: "pending", cardId: "new", role: "tester", verdictPath: "/vn", dispatchedAt: iso(NOW - 5_000) }),
  ].join("\n");
  const activity = new Map([
    ["old", { cardId: "old", event: "dispatched", at: NOW - 30_000 }], // superseded by in-flight row
    ["r1", { cardId: "r1", event: "reconcile", outcome: "routed", detail: "a→b", at: NOW - 8_000 }],
    ["r2", { cardId: "r2", event: "reconcile", outcome: "routed", detail: "c→d", at: NOW - 1_000 }],
  ]);
  const rows = assembleBoard({ activityMap: activity, manifestContent: manifest, now: NOW, staleS: 7200 });
  assert.deepEqual(rows.map((r) => r.cardId), ["old", "new", "r2", "r1"]);
  assert.equal(rows.filter((r) => r.cardId === "old").length, 1, "in-flight card not duplicated");
});
