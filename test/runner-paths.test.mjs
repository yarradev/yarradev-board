import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir, stateDir, manifestPath, logDir, resolveHome } from "../skills/yarradev-run/scripts/runner/paths.mjs";

// Helper: force process.platform for the duration of `fn`, then restore the
// original (read-only) getter from its captured descriptor — even on throw.
function withPlatform(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", { value, configurable: true });
    fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

test("dataDir on win32 uses LOCALAPPDATA", () => {
  withPlatform("win32", () => {
    assert.equal(dataDir({ LOCALAPPDATA: "C:\\AppData\\Local" }), "C:\\AppData\\Local");
  });
});

test("dataDir on win32 falls back to homedir()/AppData/Local when LOCALAPPDATA unset", () => {
  withPlatform("win32", () => {
    assert.equal(dataDir({}), join(homedir(), "AppData", "Local"));
  });
});

test("dataDir on linux/posix uses XDG_DATA_HOME", () => {
  withPlatform("linux", () => {
    assert.equal(dataDir({ XDG_DATA_HOME: "/data" }), "/data");
  });
});

test("logDir is <stateDir>/logs", () => {
  assert.equal(logDir({ YARRADEV_STATE_DIR: "/s" }), join("/s", "logs"));
});

test("stateDir honors YARRADEV_STATE_DIR override", () => {
  assert.equal(stateDir({ YARRADEV_STATE_DIR: "/tmp/x" }), "/tmp/x");
});

test("stateDir defaults to <dataDir>/yarradev", () => {
  // dataDir() branches on process.platform; force posix so XDG_DATA_HOME is honored
  // regardless of the platform this suite actually runs on (e.g. win32 CI).
  withPlatform("linux", () => {
    const env = { XDG_DATA_HOME: "/data" };
    assert.equal(stateDir(env), join("/data", "yarradev"));
  });
});

test("manifestPath is under stateDir", () => {
  assert.equal(manifestPath({ YARRADEV_STATE_DIR: "/s" }), join("/s", "dispatch-manifest.jsonl"));
});

test("resolveHome prefers YARRADEV_HOME over CLAUDE_PLUGIN_ROOT", () => {
  assert.equal(resolveHome({ YARRADEV_HOME: "/h", CLAUDE_PLUGIN_ROOT: "/c" }), "/h");
});

test("resolveHome falls back to CLAUDE_PLUGIN_ROOT when YARRADEV_HOME unset", () => {
  assert.equal(resolveHome({ CLAUDE_PLUGIN_ROOT: "/c" }), "/c");
});

test("resolveHome computes the repo root via the 5-level dirname walk when neither env var is set", () => {
  const root = resolveHome({});
  assert.ok(existsSync(join(root, "package.json")));
});
