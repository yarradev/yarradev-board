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

test("renderBoard: alignment is discriminating (column padding required)", () => {
  const out = renderBoard([
    { cardId: "c1-nav-shell", role: "designer", state: "in-flight", ageS: 12, last: "dispatched" },
    { cardId: "c3-auth", role: "-", state: "advanced", ageS: 2, last: "dev→test" },
  ]);
  const lines = out.split("\n");

  // Find column start positions in the header
  const headerLine = lines[0];
  const roleStart = headerLine.indexOf("ROLE");
  const stateStart = headerLine.indexOf("STATE");
  const ageStart = headerLine.indexOf("AGE");
  const lastStart = headerLine.indexOf("LAST");

  // Extract column substrings at those exact positions from each row.
  // Column end = start of next column minus 2 (for the separator).
  const roleEnd = stateStart - 2;
  const stateEnd = ageStart - 2;
  const ageEnd = lastStart - 2;

  // Verify ROLE column alignment and content
  const row1Role = lines[1].substring(roleStart, roleEnd).trim();
  const row2Role = lines[2].substring(roleStart, roleEnd).trim();
  assert.equal(row1Role, "designer", "row 1 ROLE value");
  assert.equal(row2Role, "-", "row 2 ROLE value");

  // Verify STATE column alignment and content
  const row1State = lines[1].substring(stateStart, stateEnd).trim();
  const row2State = lines[2].substring(stateStart, stateEnd).trim();
  assert.equal(row1State, "in-flight", "row 1 STATE value");
  assert.equal(row2State, "advanced", "row 2 STATE value");

  // Verify AGE column alignment and content
  const row1Age = lines[1].substring(ageStart, ageEnd).trim();
  const row2Age = lines[2].substring(ageStart, ageEnd).trim();
  assert.equal(row1Age, "12s", "row 1 AGE value");
  assert.equal(row2Age, "2s", "row 2 AGE value");
});

test("renderBoard: empty rows → idle line", () => {
  assert.match(renderBoard([]), /idle — nothing in flight/);
});

test("renderBoard: null ageS renders as '-'", () => {
  assert.match(renderBoard([{ cardId: "c", role: "r", state: "in-flight", ageS: null, last: "dispatched" }]), /\bc\s+r\s+in-flight\s+-\s+dispatched/);
});

test("renderBoard: color:true wraps the STATE token in ANSI", () => {
  const out = renderBoard([{ cardId: "c", role: "-", state: "ESCALATED", ageS: 1, last: "422 parked" }], { color: true });
  assert.match(out, /\x1b\[31m.*ESCALATED.*\x1b\[0m/, "ESCALATED is red");
});

test("renderBoard: color:true wraps in-flight, advanced, retrying in their respective colors", () => {
  const out = renderBoard([
    { cardId: "c1", role: "-", state: "in-flight", ageS: 1, last: "x" },
    { cardId: "c2", role: "-", state: "advanced", ageS: 1, last: "x" },
    { cardId: "c3", role: "-", state: "retrying", ageS: 1, last: "x" },
  ], { color: true });
  assert.match(out, /\x1b\[36m.*in-flight.*\x1b\[0m/, "in-flight is cyan");
  assert.match(out, /\x1b\[32m.*advanced.*\x1b\[0m/, "advanced is green");
  assert.match(out, /\x1b\[33m.*retrying.*\x1b\[0m/, "retrying is yellow");
});
