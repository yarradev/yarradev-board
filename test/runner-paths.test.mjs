import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { dataDir, stateDir, manifestPath, resolveHome } from "../skills/yarradev-run/scripts/runner/paths.mjs";

test("stateDir honors YARRADEV_STATE_DIR override", () => {
  assert.equal(stateDir({ YARRADEV_STATE_DIR: "/tmp/x" }), "/tmp/x");
});

test("stateDir defaults to <dataDir>/yarradev", () => {
  const env = { XDG_DATA_HOME: "/data" };
  assert.equal(stateDir(env), join("/data", "yarradev"));
});

test("manifestPath is under stateDir", () => {
  assert.equal(manifestPath({ YARRADEV_STATE_DIR: "/s" }), join("/s", "dispatch-manifest.jsonl"));
});

test("resolveHome prefers YARRADEV_HOME over CLAUDE_PLUGIN_ROOT", () => {
  assert.equal(resolveHome({ YARRADEV_HOME: "/h", CLAUDE_PLUGIN_ROOT: "/c" }), "/h");
});
