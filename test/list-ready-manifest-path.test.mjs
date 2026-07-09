// test/list-ready-manifest-path.test.mjs
//
// Regression test for the manifest split-brain bug: list-ready.mjs used to derive its own
// (stale, "claude-bg"-scheme) manifest path independently of dispatch.mjs/pass.mjs, so its
// in-flight guard always read an empty/missing file and never skipped a card whose subagent
// was still running (double-dispatch / worktree corruption risk).
//
// list-ready.mjs has no CLI-body guard (it runs top-level on import, hitting the network), so we
// can't import it directly in a unit test. Instead we assert:
//   1. Source-level: the file imports the shared `manifestPath` helper from runner/paths.mjs and
//      no longer contains the old "claude-bg" scheme.
//   2. Behavioral (indirect): the SAME helper that dispatch.mjs/pass.mjs use resolves the manifest
//      path we expect list-ready.mjs to now produce — i.e. there is exactly one source of truth.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { manifestPath } from "../skills/yarradev-run/scripts/runner/paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIST_READY = join(HERE, "..", "skills", "yarradev-run", "scripts", "list-ready.mjs");

test("list-ready.mjs no longer derives its own (stale) manifest path scheme", () => {
  const src = readFileSync(LIST_READY, "utf8");
  assert.doesNotMatch(src, /claude-bg/, "list-ready.mjs must not reference the old claude-bg manifest scheme");
  assert.match(src, /from ["']\.\/runner\/paths\.mjs["']/, "list-ready.mjs must import from ./runner/paths.mjs");
  assert.match(src, /manifestPath as resolveManifestPath/, "list-ready.mjs must import the shared manifestPath helper (aliased to avoid shadowing its local const)");
  assert.match(src, /resolveManifestPath\s*\(\s*\)/, "list-ready.mjs must call the shared manifestPath() helper");
});

test("the shared manifestPath() helper (what list-ready/dispatch/pass all now resolve through) is deterministic", () => {
  const env = { YARRADEV_STATE_DIR: "/x" };
  // dispatch.mjs and pass.mjs both resolve the manifest via this exact helper (see dispatch.mjs's
  // `manifestPath()` const and pass.mjs's `resolveManifestPath()` import-alias). list-ready.mjs now
  // imports and calls the identical function, so all three agree by construction — a single
  // source of truth instead of three independently-derived paths.
  assert.equal(manifestPath(env), "/x/dispatch-manifest.jsonl");
});
