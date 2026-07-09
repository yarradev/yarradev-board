import { test } from "node:test";
import assert from "node:assert/strict";
import { buildActions } from "../bin/yarradev.mjs";

test("buildActions.pause pauses the daemon", () => {
  let paused = false;
  const daemon = { pause: () => { paused = true; }, resume() {}, requestTick() {} };
  const actions = buildActions({ daemon });
  assert.deepEqual(actions.pause(), { ok: true, paused: true });
  assert.equal(paused, true);
});
