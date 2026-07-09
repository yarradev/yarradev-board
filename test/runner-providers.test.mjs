// test/runner-providers.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readBreaker, computeNextTickAt, latestEntryForCard, readVerdict } from "../skills/yarradev-run/scripts/runner/providers.mjs";

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
