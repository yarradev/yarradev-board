/*
 * fingerprint.test.mjs — Task A8/U4 (auto-raised bug cards, code-reviewer wiring). Pins
 * `fingerprint.mjs`: an LLM reviewer cannot reliably compute a sha256 fingerprint itself, so the
 * code-reviewer emits RAW spawn entries `{title, file, summary, note?}` and the CONDUCTOR computes the
 * deterministic `bug-<fp>` id via this helper (which imports bugFingerprint/bugCardId from the vendored
 * ./vendor/core.mjs). Assertions mirror packages/orchestrator-core/test/fingerprint.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runFingerprint } from "../skills/yarradev-run/scripts/fingerprint.mjs";

test("fingerprint.mjs: known (repo,file,summary) -> stable bug-<16hex> id", async () => {
  const id = await runFingerprint("o/r", "src/x.ts", "Off-by-one in loop");
  assert.match(id, /^bug-[0-9a-f]{16}$/);
  // stable across repeated calls (deterministic, not random)
  const again = await runFingerprint("o/r", "src/x.ts", "Off-by-one in loop");
  assert.equal(id, again);
});

test("fingerprint.mjs: stable across whitespace/case drift in summary (normalize)", async () => {
  const a = await runFingerprint("o/r", "src/x.ts", "Off-by-one in loop");
  const b = await runFingerprint("o/r", "src/x.ts", "  off-by-one in LOOP  ");
  assert.equal(a, b, "normalized summary must dedup trivial wording drift");
});

test("fingerprint.mjs: differs by file and by summary", async () => {
  const byFile1 = await runFingerprint("o/r", "a.ts", "x");
  const byFile2 = await runFingerprint("o/r", "b.ts", "x");
  assert.notEqual(byFile1, byFile2);

  const bySummary1 = await runFingerprint("o/r", "a.ts", "x");
  const bySummary2 = await runFingerprint("o/r", "a.ts", "y");
  assert.notEqual(bySummary1, bySummary2);
});

test("fingerprint.mjs: differs by repo (dedup key includes repo, excludes line number by design)", async () => {
  const a = await runFingerprint("o/r1", "a.ts", "x");
  const b = await runFingerprint("o/r2", "a.ts", "x");
  assert.notEqual(a, b);
});
