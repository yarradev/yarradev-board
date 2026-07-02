/*
 * assertLifecycleCoherent (Task 8 — single-source the lifecycle) — vendored from orchestrator-core
 * (skills/yarradev-board-run/scripts/vendor/core.mjs). Confirms the SHIPPED board.example.json
 * lifecycle is coherent with a representative BoardMachine (as GET /config would return for a live
 * board running that same 11-state lifecycle, 7 base + 4 epic-tier as of Phase 2b Task 8), and pins
 * the fail-closed diff behavior list-ready.mjs
 * relies on to refuse routing on incoherence.
 *
 * A live check against acme:main needs a bearer token and is NOT run here — see the Task 8 report's
 * acceptance-gate note.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertLifecycleCoherent } from "../skills/yarradev-board-run/scripts/vendor/core.mjs";

const EXAMPLE = JSON.parse(
  readFileSync(new URL("../skills/yarradev-board-run/config/board.example.json", import.meta.url), "utf8")
);

/** A representative BoardMachine for a lifecycle — mirrors what a live board's GET /config would
 *  report for a board actually running this lifecycle (one transition per non-terminal forward edge). */
function machineFor(lifecycle) {
  const states = Object.keys(lifecycle);
  const transitions = states
    .filter((s) => lifecycle[s].to != null)
    .map((s) => ({ type: "MOVE", from: s, to: lifecycle[s].to }));
  return { initial: states[0] ?? null, states, terminal: states.filter((s) => lifecycle[s].to == null), transitions };
}

test("assertLifecycleCoherent: the shipped board.example.json 11-state lifecycle is coherent with a matching machine", () => {
  const lc = EXAMPLE.lifecycle;
  assert.deepEqual(Object.keys(lc), [
    "backlog", "spec", "dev", "test", "done", "staging", "prod",
    "epic_analysis", "epic_decompose", "epic_integrating", "epic_done",
  ]); // shape is pinned (7 base + 4 epic-tier, Phase 2b Task 8)
  assert.doesNotThrow(() => assertLifecycleCoherent(lc, machineFor(lc)));
});

test("assertLifecycleCoherent: throws naming a state missing from the machine", () => {
  const lc = EXAMPLE.lifecycle;
  const machine = machineFor(lc);
  machine.states = machine.states.filter((s) => s !== "backlog");
  machine.transitions = machine.transitions.filter((t) => t.from !== "backlog");
  assert.throws(() => assertLifecycleCoherent(lc, machine), /backlog/);
});

test("assertLifecycleCoherent: throws naming a state missing from the lifecycle", () => {
  const lc = EXAMPLE.lifecycle;
  const machine = machineFor(lc);
  machine.states = [...machine.states, "archived"];
  assert.throws(() => assertLifecycleCoherent(lc, machine), /archived/);
});

test("assertLifecycleCoherent: throws naming a forward edge missing from machine.transitions", () => {
  const lc = EXAMPLE.lifecycle;
  const machine = machineFor(lc);
  machine.transitions = machine.transitions.filter((t) => !(t.from === "dev" && t.to === "test"));
  assert.throws(() => assertLifecycleCoherent(lc, machine), /dev->test/);
});

test("assertLifecycleCoherent: null/missing machine (GET /config down) must be handled by the caller as fail-closed — this fn only validates a non-null machine", () => {
  // list-ready.mjs's own null-machine guard is exercised at the process level (see the report); this
  // pins the contract assertLifecycleCoherent itself requires a BoardMachine object, not null.
  assert.throws(() => assertLifecycleCoherent(EXAMPLE.lifecycle, null));
});
