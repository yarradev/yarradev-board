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

// append to test/runner-cli.test.mjs
import { clientUrl } from "../bin/yarradev.mjs";
test("clientUrl maps subcommands to control-plane routes", () => {
  assert.equal(clientUrl("status", 4599), "http://127.0.0.1:4599/status");
  assert.equal(clientUrl("pause", 4599), "http://127.0.0.1:4599/pause");
});
