/*
 * in-flight.test.mjs — pins GH #27: list-ready must skip cards whose latest dispatch is still running
 * (pending with no matching done, recent). Pure helper, injected `now` — no manifest file, no I/O.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inFlightCardIds } from "../skills/yarradev-run/scripts/in-flight.mjs";

const NOW = Date.UTC(2026, 6, 7, 15, 0, 0); // 2026-07-07T15:00:00Z — fixed, no Date.now()
const RECENT = "2026-07-07T14:55:00Z"; // 5 min ago
const STALE = "2026-07-07T10:00:00Z"; // 5 h ago
const STALE_S = 7200; // 2h

function entry(status, cardId, verdictPath, ts) {
  const base = { status, cardId, verdictPath, role: "developer" };
  if (status === "pending") base.dispatchedAt = ts;
  if (status === "done") base.completedAt = ts ?? RECENT;
  return JSON.stringify(base);
}

test("pending with no done, recent → in-flight (skip)", () => {
  const m = entry("pending", "card-1", "/v/1", RECENT);
  assert.deepEqual([...inFlightCardIds(m, NOW, STALE_S)], ["card-1"]);
});

test("pending with a matching done → NOT in-flight (subagent finished → re-dispatchable)", () => {
  const m = [entry("pending", "card-1", "/v/1", RECENT), entry("done", "card-1", "/v/1")].join("\n");
  assert.deepEqual([...inFlightCardIds(m, NOW, STALE_S)], [], "finished dispatch must not block the card");
});

test("pending with no done, older than staleS → NOT in-flight (presumed dead)", () => {
  const m = entry("pending", "card-1", "/v/1", STALE); // 5h > 2h staleS
  assert.deepEqual([...inFlightCardIds(m, NOW, STALE_S)], []);
});

test("pending just inside staleS → in-flight; just outside → not (boundary)", () => {
  const within = entry("pending", "c", "/v/a", new Date(NOW - (STALE_S * 1000 - 1)).toISOString());
  const atEdge = entry("pending", "c", "/v/b", new Date(NOW - STALE_S * 1000).toISOString());
  assert.deepEqual([...inFlightCardIds(within, NOW, STALE_S)], ["c"]);
  assert.deepEqual([...inFlightCardIds(atEdge, NOW, STALE_S)], [], "exactly staleS old is treated as stale");
});

test("untimestamped pending → in-flight (conservative: never risk a duplicate)", () => {
  const m = `{"status":"pending","cardId":"c","verdictPath":"/v/x","role":"developer"}`;
  assert.deepEqual([...inFlightCardIds(m, NOW, STALE_S)], ["c"]);
});

test("mixed cards: only the unresolved-recent one is in-flight", () => {
  const m = [
    entry("pending", "card-A", "/v/a", RECENT), // in-flight
    entry("pending", "card-B", "/v/b", RECENT), entry("done", "card-B", "/v/b"), // finished
    entry("pending", "card-C", "/v/c", STALE), // dead
  ].join("\n");
  assert.deepEqual([...inFlightCardIds(m, NOW, STALE_S)], ["card-A"]);
});

test("a card with a later unresolved dispatch stays in-flight even after an earlier one finished", () => {
  // First dispatch finished (done), then a re-dispatch is pending — the card is in-flight again.
  const m = [
    entry("pending", "card-1", "/v/old", "2026-07-07T13:00:00Z"),
    entry("done", "card-1", "/v/old"),
    entry("pending", "card-1", "/v/new", RECENT), // unresolved
  ].join("\n");
  assert.deepEqual([...inFlightCardIds(m, NOW, STALE_S)], ["card-1"]);
});

test("empty / null / malformed manifest → empty set (never throws)", () => {
  assert.deepEqual([...inFlightCardIds("", NOW, STALE_S)], []);
  assert.deepEqual([...inFlightCardIds(null, NOW, STALE_S)], []);
  assert.deepEqual([...inFlightCardIds(undefined, NOW, STALE_S)], []);
  assert.deepEqual([...inFlightCardIds("{garbage\n\n{not-json", NOW, STALE_S)], []);
});

test("ignores entries missing cardId or verdictPath", () => {
  const m = [
    `{"status":"pending","cardId":"c","role":"developer"}`, // no verdictPath
    `{"status":"pending","verdictPath":"/v/x","role":"developer"}`, // no cardId
  ].join("\n");
  assert.deepEqual([...inFlightCardIds(m, NOW, STALE_S)], []);
});
