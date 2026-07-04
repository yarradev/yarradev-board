/*
 * note.test.mjs — Task A6. Pins the live poster for the "advice.spawn" bug-raising primitive: note.mjs
 * posts a gen-exempt NOTE act carrying free-form text (the repro body) on a card, following the
 * fake-client harness from release.test.mjs (no network, no real board — the FAKE's canned AppendResult
 * is what's under test, exactly like the plugin's other CLI-script unit tests).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runNote } from "../skills/yarradev-run/scripts/note.mjs";

/** A fake BoardClient: canned act, capturing every posted act. */
function fakeClient({ actResult }) {
  const acts = [];
  return {
    acts,
    async act(a) {
      acts.push(a);
      return actResult;
    },
  };
}

test("note: committed → exit 0, posts a NOTE act with data.text", async () => {
  const client = fakeClient({ actResult: { outcome: "committed", status: 202, seq: 5, applied: true } });
  const code = await runNote(client, "bug-aaaa", "repro: off-by-one in loop.ts, category=logic, source=code-reviewer");
  assert.equal(code, 0, "committed NOTE must exit 0");
  assert.equal(client.acts.length, 1, "exactly one act posted");
  assert.deepEqual(client.acts[0], {
    type: "NOTE",
    item_id: "bug-aaaa",
    data: { text: "repro: off-by-one in loop.ts, category=logic, source=code-reviewer" },
  });
});

test("note: not committed (e.g. gate_blocked) → exit 1", async () => {
  const client = fakeClient({
    actResult: { outcome: "gate_blocked", status: 422, applied: false, blocked_by: ["some_gate"] },
  });
  const code = await runNote(client, "bug-aaaa", "repro");
  assert.equal(code, 1, "a non-committed NOTE must fail closed (non-zero exit)");
  assert.equal(client.acts.length, 1, "the act is still attempted");
});

test("note: gen-exempt — no gen field on the posted act", async () => {
  const client = fakeClient({ actResult: { outcome: "committed", status: 202, applied: true } });
  await runNote(client, "bug-bbbb", "some text");
  assert.equal(client.acts[0].gen, undefined, "NOTE is gen-exempt (no gen arg)");
});
