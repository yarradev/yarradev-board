/*
 * advisor-act-role.test.mjs — pins the acting-advisor role into the ADVICE act body at the client seam
 * (issue #88). The board resolves an advisor act's advisor_state key as `data.role ?? input.roles[0]`.
 * Under the per-role token model roles[0] was always the advisor, so advice()'s omission of data.role
 * was invisible. Under the single shared runner token one delegate carries every BOARD_OPERATOR_ROLES
 * entry and roles[0] is always "orchestrator", so a clean review lands under a key no gate reads:
 * advisor_clear never goes non-vacuous → the card wedges at its advisor stage and the advisor is
 * re-dispatched every tick, while the ADVICE act itself returns 202 committed (silent).
 *
 * veto()/hold()/clearVeto()/clearHold() already send data.role; advice() was the only one that did not.
 * These tests drive the vendored BoardClient directly (fetch injected), so they pin the generated
 * bundle — the source of truth is @yarradev/orchestrator-core's boardClient.ts in the platform repo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BoardClient } from "../skills/yarradev-run/scripts/vendor/core.mjs";

function stubFetch(calls) {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 202,
      json: async () => ({ outcome: "committed", status: 202, seq: 1, applied: true }),
    };
  };
}

function client(calls, role) {
  return new BoardClient({
    apiBase: "http://board.test",
    doName: "b",
    token: "t",
    role,
    fetch: stubFetch(calls),
  });
}

test("advice() sends the acting advisor role in data.role", async () => {
  const calls = [];
  await client(calls, "code-reviewer").advice("card-1", "abc123", "looks fine");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.type, "ADVICE");
  assert.deepEqual(calls[0].body.data, {
    role: "code-reviewer",
    reviewed_head: "abc123",
    reason: "looks fine",
  });
});

test("advice() omits data.role when the client carries no role (unchanged for roleless callers)", async () => {
  const calls = [];
  await client(calls, undefined).advice("card-1", "abc123");

  assert.deepEqual(calls[0].body.data, { reviewed_head: "abc123", reason: "" });
  assert.equal("role" in calls[0].body.data, false, "must not send role: undefined");
});

test("advice() role never leaks to the act envelope — identity stays server-set from the bearer", async () => {
  const calls = [];
  await client(calls, "code-reviewer").advice("card-1", "abc123");

  assert.deepEqual(Object.keys(calls[0].body).sort(), ["data", "gen", "item_id", "type"]);
});

test("veto()/hold() keep their security-advisor role regardless of the client's role", async () => {
  // veto/hold authority is security-advisor-exclusive, so the hardcoded role is correct — asserted
  // here so the asymmetry with advice() is deliberate and not read as the same bug.
  const calls = [];
  const c = client(calls, "code-reviewer");
  await c.veto("card-1", "nope", "abc123");
  await c.hold("card-1", "wait", "abc123");

  assert.equal(calls[0].body.data.role, "security-advisor");
  assert.equal(calls[1].body.data.role, "security-advisor");
});
