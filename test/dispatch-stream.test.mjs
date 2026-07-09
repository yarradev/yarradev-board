// test/dispatch-stream.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { streamClaude } from "../skills/yarradev-run/scripts/dispatch.mjs";

function fakeSpawn(chunks, code) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(async () => {
    for (const c of chunks) child.stdout.emit("data", Buffer.from(c));
    child.emit("close", code);
  });
  return child;
}

test("streamClaude writes output incrementally and resolves rc", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yd-stream-"));
  const verdictPath = join(dir, "verdict.txt");
  const { rc } = await streamClaude({
    claudeBin: "claude", args: [], promptPath: "/dev/null", verdictPath,
    spawn: () => fakeSpawn(["hello ", "world"], 0),
  });
  assert.equal(rc, 0);
  assert.equal(readFileSync(verdictPath, "utf8"), "hello world");
});
