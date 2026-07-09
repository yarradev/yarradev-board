import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBoard } from "../skills/yarradev-run/scripts/runner/render-board.mjs";

test("renderBoard: aligned header + rows, plain (no ANSI) by default", () => {
  const out = renderBoard([
    { cardId: "c1-nav-shell", role: "designer", state: "in-flight", ageS: 12, last: "dispatched" },
    { cardId: "c3-auth", role: "-", state: "advanced", ageS: 2, last: "dev→test" },
  ]);
  const lines = out.split("\n");
  assert.match(lines[0], /^CARD\s+ROLE\s+STATE\s+AGE\s+LAST$/);
  assert.match(out, /c1-nav-shell\s+designer\s+in-flight\s+12s\s+dispatched/);
  assert.match(out, /c3-auth\s+-\s+advanced\s+2s\s+dev→test/);
  assert.doesNotMatch(out, /\x1b\[/, "no ANSI when color is off");
});

test("renderBoard: empty rows → idle line", () => {
  assert.match(renderBoard([]), /idle — nothing in flight/);
});

test("renderBoard: null ageS renders as '-'", () => {
  assert.match(renderBoard([{ cardId: "c", role: "r", state: "in-flight", ageS: null, last: "dispatched" }]), /\bc\s+r\s+in-flight\s+-\s+dispatched/);
});

test("renderBoard: color:true wraps the STATE token in ANSI", () => {
  const out = renderBoard([{ cardId: "c", role: "-", state: "ESCALATED", ageS: 1, last: "422 parked" }], { color: true });
  assert.match(out, /\x1b\[31m.*ESCALATED.*\x1b\[0m/);
});
