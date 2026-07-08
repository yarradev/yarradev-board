/*
 * dispatch-and-wait.test.mjs — pins GH #19: the wrapper detects the subagent's completion by scanning the
 * dispatch manifest for the matching `done` entry (correlation key = verdictPath, NOT cardId — a card can
 * have many dispatches). Tests the pure manifestHasDone() helper with fixture JSONL; the spawn/poll shell
 * is thin and exercised manually (it wraps a user-local tool that isn't present in CI).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { manifestHasDone, sanitizeEnv } from "../skills/yarradev-run/scripts/dispatch-and-wait.mjs";

const VP = "/tmp/yarradev-dispatch/designer-card-1-123-456/verdict.txt";

test("manifestHasDone: true when a matching done entry exists", () => {
  const manifest = [
    `{"status":"pending","cardId":"card-1","verdictPath":"${VP}","gen":"3","role":"designer","dispatchedAt":"2026-07-06T22:00:00Z"}`,
    `{"status":"done","cardId":"card-1","verdictPath":"${VP}","gen":"3","role":"designer","completedAt":"2026-07-06T22:05:00Z"}`,
  ].join("\n");
  assert.equal(manifestHasDone(manifest, VP), true);
});

test("manifestHasDone: false when only a pending entry exists (subagent still running)", () => {
  // This is the core of GH #19: pending-without-done must NOT be treated as ready (the old `cat $V` bug).
  const manifest = `{"status":"pending","cardId":"card-1","verdictPath":"${VP}","role":"designer"}`;
  assert.equal(manifestHasDone(manifest, VP), false);
});

test("manifestHasDone: false when a done entry exists for a DIFFERENT verdictPath", () => {
  // Correlation is verdictPath, not cardId — two dispatches for the same card produce distinct verdictPaths.
  const other = "/tmp/yarradev-dispatch/designer-card-1-999-111/verdict.txt";
  const manifest = `{"status":"done","cardId":"card-1","verdictPath":"${other}","role":"designer"}`;
  assert.equal(manifestHasDone(manifest, VP), false);
});

test("manifestHasDone: false on empty / missing manifest", () => {
  assert.equal(manifestHasDone("", VP), false);
  assert.equal(manifestHasDone(undefined, VP), false);
});

test("manifestHasDone: skips malformed lines without crashing", () => {
  // A partial/garbled append must never break reconciliation of a later, well-formed done entry.
  const manifest = `{garbage\n\n{"status":"done","verdictPath":"${VP}","role":"designer"}`;
  assert.equal(manifestHasDone(manifest, VP), true);
});

test("manifestHasDone: ignores a `done` whose verdictPath differs only by trailing newline/space", () => {
  const manifest = `{"status":"done","verdictPath":"${VP} ","role":"designer"}`;
  assert.equal(manifestHasDone(manifest, VP), false, "exact verdictPath match required");
});

test("sanitizeEnv: strips every YDB_TOKEN* key, leaves everything else (GH #25)", () => {
  const out = sanitizeEnv({
    PATH: "/usr/bin",
    HOME: "/Users/x",
    YDB_TOKEN: "shaped.<secret>",
    YDB_TOKEN_ORCHESTRATOR: "orch.<secret>",
    YDB_TOKEN_DEVELOPER: "dev.<secret>",
    YDB_TOKEN_SECURITY_ADVISOR: "sec.<secret>",
    CLOUDFLARE_API_TOKEN: "cf.<secret>",
    GITHUB_TOKEN: "gh.<secret>",
  });
  assert.equal(out.YDB_TOKEN, undefined, "shared YDB_TOKEN stripped");
  assert.equal(out.YDB_TOKEN_ORCHESTRATOR, undefined, "per-role orchestrator token stripped");
  assert.equal(out.YDB_TOKEN_DEVELOPER, undefined, "per-role developer token stripped");
  assert.equal(out.YDB_TOKEN_SECURITY_ADVISOR, undefined, "per-role advisor token stripped");
  assert.equal(out.PATH, "/usr/bin", "PATH preserved");
  assert.equal(out.HOME, "/Users/x", "HOME preserved");
  assert.equal(out.CLOUDFLARE_API_TOKEN, "cf.<secret>", "role CF credential preserved (devops needs it)");
  assert.equal(out.GITHUB_TOKEN, "gh.<secret>", "GitHub credential preserved");
});

test("sanitizeEnv: does not mutate the input env", () => {
  const input = { PATH: "/usr/bin", YDB_TOKEN: "secret", YDB_TOKEN_RELEASER: "r" };
  const out = sanitizeEnv(input);
  assert.equal(input.YDB_TOKEN, "secret", "input untouched");
  assert.equal(input.YDB_TOKEN_RELEASER, "r", "input untouched");
  assert.equal(out.YDB_TOKEN, undefined);
  assert.notEqual(out, input, "returns a distinct copy");
});

test("sanitizeEnv: env with no YDB_TOKEN keys is returned unchanged (content-wise)", () => {
  const out = sanitizeEnv({ PATH: "/usr/bin", HOME: "/h" });
  assert.deepEqual(out, { PATH: "/usr/bin", HOME: "/h" });
});

test("sanitizeEnv: case-insensitive strip (catches accidental lowercase export)", () => {
  const out = sanitizeEnv({ ydb_token: "secret", YDB_TOKEN_DEVELOPER: "d", PATH: "/x" });
  assert.equal(out.ydb_token, undefined);
  assert.equal(out.YDB_TOKEN_DEVELOPER, undefined);
  assert.equal(out.PATH, "/x");
});
