/*
 * pass-native.test.mjs — GH #51: pass.mjs surfaces dispatch.mjs's native dispatch-request to the conductor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNativeDispatchOutput } from "../skills/yarradev-run/scripts/pass.mjs";

test("parseNativeDispatchOutput: extracts verdictPath + the raw request line", () => {
  const line = JSON.stringify({ action: "dispatch-request", role: "developer", cardId: "c1", verdictPath: "/t/v.txt", promptPath: "/t/p.txt" });
  const out = parseNativeDispatchOutput(line + "\n");
  assert.equal(out.verdictPath, "/t/v.txt");
  assert.equal(out.requestLine, line);
});

test("parseNativeDispatchOutput: ignores leading log noise, takes the last JSON line", () => {
  const line = JSON.stringify({ action: "dispatch-request", cardId: "c2", verdictPath: "/t/v2.txt" });
  const out = parseNativeDispatchOutput("some stderr bleed\n" + line + "\n");
  assert.equal(out.verdictPath, "/t/v2.txt");
});

test("parseNativeDispatchOutput: throws on malformed output", () => {
  assert.throws(() => parseNativeDispatchOutput("not json\n"));
  assert.throws(() => parseNativeDispatchOutput(""));
});
