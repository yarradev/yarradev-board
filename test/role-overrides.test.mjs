/*
 * role-overrides.test.mjs — GH #53: per-role config (model/effort/worktree/subagentType) from board.json.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeRoles, sanitizeRoles, loadRoleOverrides, readJsonOr } from "../skills/yarradev-run/scripts/dispatch.mjs";

test("mergeRoles: higher layer overrides per field, lower fields survive", () => {
  const out = mergeRoles(
    { developer: { model: "sonnet", worktree: true } },
    { developer: { model: "opus" } },
    { developer: { effort: "high" } },
  );
  assert.deepEqual(out, { developer: { model: "opus", worktree: true, effort: "high" } });
});

test("mergeRoles: absent/nullish layers are treated as empty", () => {
  assert.deepEqual(mergeRoles(undefined, { tester: { model: "haiku" } }, null), { tester: { model: "haiku" } });
});

test("sanitizeRoles: drops invalid subagentType and non-boolean worktree, keeps the rest", () => {
  const { cleaned, warnings } = sanitizeRoles({
    developer: { model: "opus", subagentType: "Frobnicate", worktree: "yes" },
    tester: { model: "haiku", subagentType: "Explore", worktree: true },
  });
  assert.deepEqual(cleaned, {
    developer: { model: "opus" },
    tester: { model: "haiku", subagentType: "Explore", worktree: true },
  });
  assert.equal(warnings.length, 2);
});

test("loadRoleOverrides: merges .roles across example/install/project layers", () => {
  const dir = mkdtempSync(join(tmpdir(), "yd-roles-"));
  const configDir = join(dir, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "board.example.json"), JSON.stringify({ roles: { developer: { model: "sonnet" } } }));
  // no install board.json
  const cwd = join(dir, "proj");
  mkdirSync(join(cwd, ".yarradev"), { recursive: true });
  writeFileSync(join(cwd, ".yarradev", "board.json"), JSON.stringify({ roles: { developer: { model: "opus", worktree: false } } }));
  const out = loadRoleOverrides({ configDir, cwd });
  assert.deepEqual(out, { developer: { model: "opus", worktree: false } });
});

test("loadRoleOverrides: no config files → {}", () => {
  const dir = mkdtempSync(join(tmpdir(), "yd-roles-empty-"));
  assert.deepEqual(loadRoleOverrides({ configDir: join(dir, "config"), cwd: join(dir, "proj") }), {});
});

test("readJsonOr: malformed JSON (present-but-invalid) is non-fatal → {}, not thrown", () => {
  const dir = mkdtempSync(join(tmpdir(), "yd-roles-malformed-"));
  const badPath = join(dir, "board.json");
  writeFileSync(badPath, "{ \"roles\": { \"developer\": { \"model\": \"opus\", } } }"); // trailing comma
  assert.doesNotThrow(() => readJsonOr(badPath));
  assert.deepEqual(readJsonOr(badPath), {});
});

// §7 — board-config roles injected as the highest-precedence layer via YARRADEV_BOARD_ROLES.
test("mergeRoles: variadic — the last (highest-precedence) layer wins per field", () => {
  const out = mergeRoles(
    { developer: { model: "sonnet", effort: "low" } }, // example
    { developer: { model: "opus" } }, // install
    { developer: { effort: "medium" } }, // project
    { developer: { model: "haiku", effort: "high" } }, // board config (top)
  );
  assert.deepEqual(out, { developer: { model: "haiku", effort: "high" } });
});

test("loadRoleOverrides: board-config env layer overrides project .yarradev/board.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "yd-boardroles-"));
  const configDir = join(dir, "config");
  const projDir = join(dir, "proj");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(projDir, ".yarradev"), { recursive: true });
  writeFileSync(join(configDir, "board.example.json"), JSON.stringify({ roles: {} }));
  writeFileSync(join(configDir, "board.json"), JSON.stringify({ roles: {} }));
  writeFileSync(
    join(projDir, ".yarradev", "board.json"),
    JSON.stringify({ roles: { developer: { model: "sonnet" } } }),
  );
  const prev = process.env.YARRADEV_BOARD_ROLES;
  process.env.YARRADEV_BOARD_ROLES = JSON.stringify({ developer: { model: "opus" } });
  try {
    assert.deepEqual(loadRoleOverrides({ configDir, cwd: projDir }), {
      developer: { model: "opus" },
    });
  } finally {
    if (prev === undefined) delete process.env.YARRADEV_BOARD_ROLES;
    else process.env.YARRADEV_BOARD_ROLES = prev;
  }
});

test("loadRoleOverrides: absent/malformed YARRADEV_BOARD_ROLES falls back to file layers", () => {
  const dir = mkdtempSync(join(tmpdir(), "yd-boardroles-bad-"));
  const configDir = join(dir, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "board.example.json"),
    JSON.stringify({ roles: { tester: { model: "haiku" } } }),
  );
  const prev = process.env.YARRADEV_BOARD_ROLES;
  process.env.YARRADEV_BOARD_ROLES = "not json{";
  try {
    assert.deepEqual(loadRoleOverrides({ configDir, cwd: dir }), { tester: { model: "haiku" } });
  } finally {
    if (prev === undefined) delete process.env.YARRADEV_BOARD_ROLES;
    else process.env.YARRADEV_BOARD_ROLES = prev;
  }
});
