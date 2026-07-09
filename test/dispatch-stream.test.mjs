// test/dispatch-stream.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
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

// Like fakeSpawn, but exposes a real writable `child.stdin` (a PassThrough) so
// `.pipe(child.stdin)` is actually attempted — the real `spawn`'s default stdio gives a
// writable child.stdin; the plain fakeSpawn above omits it, which skips the pipe/error path
// entirely (see streamClaude's docstring). Never closes on its own; tests settle the
// returned promise via the ReadStream/stdin 'error' path instead of "close".
function fakeSpawnWithStdin(code) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new PassThrough();
  child.killCalls = 0;
  child.kill = () => { child.killCalls += 1; };
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

test("streamClaude rejects (not crashes) when promptPath doesn't exist (ENOENT on the prompt ReadStream)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yd-stream-enoent-"));
  const verdictPath = join(dir, "verdict.txt");
  const missingPromptPath = join(dir, "does-not-exist.txt");
  const child = fakeSpawnWithStdin(0);
  await assert.rejects(
    streamClaude({
      claudeBin: "claude",
      args: [],
      promptPath: missingPromptPath,
      verdictPath,
      spawn: () => child,
    }),
    /ENOENT/,
  );
  // Regression: the spawned `claude` child must be killed on this error path — otherwise it's an
  // orphaned second live writer into the worktree (compounds the manifest double-dispatch risk).
  assert.equal(child.killCalls, 1);
});

test("streamClaude rejects (not crashes) when child.stdin errors (e.g. EPIPE from an early-closing child)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yd-stream-epipe-"));
  const verdictPath = join(dir, "verdict.txt");
  // A real prompt file this time — we want the ReadStream to pipe successfully and have the
  // *destination* (child.stdin) be the one that errors, simulating the child closing its stdin
  // before the prompt finishes draining.
  const promptPath = join(dir, "prompt.txt");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(promptPath, "some prompt text");

  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new PassThrough();
  child.killCalls = 0;
  child.kill = () => { child.killCalls += 1; };

  await assert.rejects(
    (async () => {
      const p = streamClaude({
        claudeBin: "claude",
        args: [],
        promptPath,
        verdictPath,
        spawn: () => child,
      });
      // Simulate the child closing/erroring its stdin (EPIPE) after piping starts.
      queueMicrotask(() => child.stdin.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" })));
      return p;
    })(),
    /EPIPE/,
  );
  // Regression: the spawned `claude` child must be killed on this error path too.
  assert.equal(child.killCalls, 1);
});
