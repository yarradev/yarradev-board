/*
 * plugin-io.test.mjs — resolveLifecycle (issue #83): which lifecycle a script routes/prompts against.
 * Pure helper shared by list-ready.mjs, pass.mjs, and build-prompt.mjs so all three resolve identically:
 * the board-served machine.lifecycle (nodes-authored boards) when GET /config serves one, else this
 * project's local .yarradev/board.json lifecycle (cfg.lifecycle) — unchanged for acme:main and any board
 * that serves no lifecycle.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLifecycle } from "../skills/yarradev-run/scripts/plugin-io.mjs";

const CFG_LIFECYCLE = { backlog: { owner: "designer", to: "spec" } };
const MACHINE_LIFECYCLE = { backlog: { owner: "developer", to: "spec" } };

test("resolveLifecycle: machine.lifecycle wins when the board serves one", () => {
  const machine = { states: ["backlog"], transitions: [], lifecycle: MACHINE_LIFECYCLE };
  assert.equal(resolveLifecycle(machine, { lifecycle: CFG_LIFECYCLE }), MACHINE_LIFECYCLE);
});

test("resolveLifecycle: falls back to cfg.lifecycle when machine.lifecycle is absent (acme:main today)", () => {
  const machine = { states: ["backlog"], transitions: [] };
  assert.equal(resolveLifecycle(machine, { lifecycle: CFG_LIFECYCLE }), CFG_LIFECYCLE);
});

test("resolveLifecycle: falls back to cfg.lifecycle when machine itself is null/undefined (GET /config failed)", () => {
  assert.equal(resolveLifecycle(null, { lifecycle: CFG_LIFECYCLE }), CFG_LIFECYCLE);
  assert.equal(resolveLifecycle(undefined, { lifecycle: CFG_LIFECYCLE }), CFG_LIFECYCLE);
});
