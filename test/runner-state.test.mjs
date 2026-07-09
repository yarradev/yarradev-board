import { test } from "node:test";
import assert from "node:assert/strict";
import { inflightRows, buildStatus } from "../skills/yarradev-run/scripts/runner/state.mjs";

const now = 1_000_000;
const manifest = [
  JSON.stringify({ status: "pending", cardId: "c1", role: "developer", verdictPath: "/v/1", dispatchedAt: new Date(now - 30_000).toISOString() }),
  JSON.stringify({ status: "done", cardId: "c2", role: "tester", verdictPath: "/v/2", dispatchedAt: new Date(now - 40_000).toISOString() }),
].join("\n");

test("inflightRows returns only unresolved-and-recent pendings with age", () => {
  const rows = inflightRows(manifest, now, 7200);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cardId, "c1");
  assert.equal(rows[0].role, "developer");
  assert.equal(rows[0].ageS, 30);
});

test("buildStatus shapes the /status payload", () => {
  const s = buildStatus({ paused: false, intervalMs: 300_000, lastTick: { at: now - 60_000, ok: true }, nextTickAt: now + 240_000, breaker: "CLOSED", passRunning: false, now });
  assert.equal(s.paused, false);
  assert.equal(s.breaker, "CLOSED");
  assert.equal(s.nextTickInS, 240);
});
