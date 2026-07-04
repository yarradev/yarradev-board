/*
 * release.test.mjs — Task R9. Pins the fail-closed contract of the autonomous prod RELEASE path
 * (release.mjs) and the gen-exempt SMOKE fact (smoke.mjs). These are SECURITY-CRITICAL: a delegate
 * token WITHOUT the `board:release` grant must NOT promote a card to prod — the board denies the
 * RELEASE act with a 403 (outcome "unauthorized"), which emit() surfaces as a non-zero exit so the
 * loop falls back to the human-GO wait. Only outcome "committed" advances.
 *
 * Unit-level & hermetic: a FAKE client (a plain object with getEnriched/act) returns canned
 * AppendResults and captures the posted act, exactly like the plugin's other unit tests. No network,
 * no real board, no tokens — so the identity/scope decision under test is the FAKE's canned outcome,
 * asserting the plugin's behavior for each board verdict.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runRelease } from "../skills/yarradev-run/scripts/release.mjs";
import { runSmoke } from "../skills/yarradev-run/scripts/smoke.mjs";

/** A fake BoardClient: canned getEnriched + act, capturing every posted act. */
function fakeClient({ card = { id: "c1", current_gen: 3 }, actResult }) {
  const acts = [];
  return {
    acts,
    async getEnriched() {
      return card;
    },
    async act(a) {
      acts.push(a);
      return actResult;
    },
  };
}

test("release: committed → exit 0, posts RELEASE at the card's CURRENT gen", async () => {
  const client = fakeClient({
    card: { id: "c1", current_gen: 3 },
    actResult: { outcome: "committed", status: 202, seq: 7, applied: true },
  });
  const code = await runRelease(client, "c1");
  assert.equal(code, 0, "committed RELEASE must exit 0");
  assert.equal(client.acts.length, 1, "exactly one act posted");
  assert.deepEqual(client.acts[0], {
    type: "RELEASE",
    item_id: "c1",
    gen: 3,
    data: { to: "prod" },
  });
});

test("release: ADVERSARIAL fail-closed — token lacks board:release → 403 unauthorized → exit 1, NOT committed", async () => {
  const client = fakeClient({
    card: { id: "c1", current_gen: 3 },
    actResult: {
      outcome: "unauthorized",
      status: 403,
      applied: false,
      reason: "delegate scope does not permit RELEASE",
    },
  });
  const code = await runRelease(client, "c1");
  assert.equal(code, 1, "a RELEASE denied for lacking board:release MUST fail closed (non-zero exit)");
  assert.notEqual(code, 0, "the card is NOT promoted without board:release scope");
  // The act was still attempted (so the board could deny it) but did NOT commit.
  assert.equal(client.acts.length, 1);
  assert.equal(client.acts[0].type, "RELEASE");
});

test("release: auto_release not green → 422 gate_blocked → exit 1, blocked_by ⊇ auto_release", async () => {
  const client = fakeClient({
    card: { id: "c1", current_gen: 3 },
    actResult: {
      outcome: "gate_blocked",
      status: 422,
      applied: false,
      blocked_by: ["auto_release"],
    },
  });
  const code = await runRelease(client, "c1");
  assert.equal(code, 1, "a blocked auto_release floor must fail closed (non-zero exit)");
});

test("release: no such card → exit 1", async () => {
  const client = fakeClient({ card: null, actResult: { outcome: "committed", status: 202 } });
  const code = await runRelease(client, "nope");
  assert.equal(code, 1, "a missing card must exit 1");
  assert.equal(client.acts.length, 0, "no act is posted for a missing card");
});

test("smoke: posts a gen-exempt SMOKE fact and returns 0 on committed", async () => {
  const client = fakeClient({ actResult: { outcome: "committed", status: 202, applied: true } });
  const code = await runSmoke(client, "c1", "staging", "success");
  assert.equal(code, 0, "a committed SMOKE must exit 0");
  assert.equal(client.acts.length, 1);
  assert.deepEqual(client.acts[0], {
    type: "SMOKE",
    item_id: "c1",
    data: { env: "staging", state: "success" },
  });
  assert.equal(client.acts[0].gen, undefined, "SMOKE is gen-exempt (no gen arg)");
});
