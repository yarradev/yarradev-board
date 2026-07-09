import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../skills/yarradev-run/scripts/pass.mjs"),
  "utf8",
);

test("pass.mjs no longer references the context-clearing flag files", () => {
  assert.ok(!src.includes("yarradev-prep-clear"), "PREP_CLEAR removed");
  assert.ok(!src.includes("yarradev-epic-pass-count"), "PASS_COUNT removed");
  assert.ok(!/advancePassCount/.test(src) || !src.includes("writeFileSync(PREP_CLEAR"), "valve removed");
});
