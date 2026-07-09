import { test } from "node:test";
import assert from "node:assert/strict";
import { manifestPath, resolveHome } from "../skills/yarradev-run/scripts/runner/paths.mjs";

test("dispatch + pass agree on manifest path via paths.mjs", () => {
  const env = { YARRADEV_STATE_DIR: "/agreed" };
  // Both modules must resolve the manifest through this same helper.
  assert.equal(manifestPath(env), "/agreed/dispatch-manifest.jsonl");
});

test("resolveHome drives agent base dir", () => {
  assert.equal(resolveHome({ YARRADEV_HOME: "/plugin" }), "/plugin");
  // dispatch.mjs must build agent paths from resolveHome(), not a hardcoded ~/work path
});
