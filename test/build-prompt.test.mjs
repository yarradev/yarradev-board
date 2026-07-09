/*
 * build-prompt.test.mjs — pins GH A5: the pure composePrompt helper renders the dispatch context +
 * forwarded notes[] + optional extras, defensively across note shapes. No board, no fs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { composePrompt, modeForGate } from "../skills/yarradev-run/scripts/build-prompt.mjs";

// GH #73: the developer's `mode` must be propagated into the dispatch prompt, derived from the stage gate.
test("modeForGate maps the mechanical gate to mechanical, everything else to judgement", () => {
  assert.equal(modeForGate("mechanical"), "mechanical");
  assert.equal(modeForGate("judgement"), "judgement");
  assert.equal(modeForGate("human"), "judgement");
  assert.equal(modeForGate("barrier"), "judgement");
  assert.equal(modeForGate(undefined), "judgement"); // no gate on the stage
  assert.equal(modeForGate(null), "judgement");
});

test("composePrompt emits mode: mechanical for a mechanical stage (restores gh pr create → submitted)", () => {
  const out = composePrompt({
    role: "developer",
    card: { id: "c1", state: "dev", title: "Add cache" },
    doName: "acme:main", to: "test", mode: "mechanical",
  });
  assert.match(out, /^mode: mechanical$/m);
});

test("composePrompt emits mode: judgement explicitly, and defaults to judgement when mode is omitted", () => {
  const withJudgement = composePrompt({
    role: "developer", card: { id: "c1", state: "spec", title: "t" }, doName: "d", to: "dev", mode: "judgement",
  });
  assert.match(withJudgement, /^mode: judgement$/m);
  // omitted → default judgement (matches agents/developer.md's default)
  const omitted = composePrompt({ role: "developer", card: { id: "c1", state: "spec", title: "t" }, doName: "d", to: "dev" });
  assert.match(omitted, /^mode: judgement$/m);
});

test("renders the dispatch context block from the card + args", () => {
  const out = composePrompt({
    role: "developer",
    card: { id: "card-1", state: "dev", title: "Add KV cache" },
    doName: "acme:main",
    to: "test",
  });
  assert.match(out, /=== Dispatch context ===/);
  assert.match(out, /doName: acme:main/);
  assert.match(out, /cardId: card-1/);
  assert.match(out, /state: dev/);
  assert.match(out, /to: test/);
  assert.match(out, /role: developer/);
  assert.match(out, /title: Add KV cache/);
});

test("forwards the card's notes[] as prior-stage context (the GH #18 guarantee)", () => {
  const out = composePrompt({
    role: "developer",
    card: {
      id: "card-1", state: "dev", title: "x",
      notes: [
        { text: "[designer→dev] Use a KV namespace\nkey files: src/cache.ts, wrangler.jsonc" },
        { text: "[code-reviewer→test] confirmed no overflow" },
      ],
    },
    doName: "acme:main", to: "test",
  });
  assert.match(out, /=== Prior-stage context .* do not re-derive/);
  assert.match(out, /\[designer→dev\] Use a KV namespace/);
  assert.match(out, /key files: src\/cache\.ts, wrangler\.jsonc/);
  assert.match(out, /\[code-reviewer→test\] confirmed no overflow/);
});

test("notes block is omitted when the card has no notes", () => {
  const out = composePrompt({ role: "developer", card: { id: "c", state: "dev", title: "t" }, doName: "d", to: "test" });
  assert.doesNotMatch(out, /Prior-stage context/);
});

test("tolerates note shapes: raw string, {text}, and unknown objects", () => {
  const out = composePrompt({
    role: "developer",
    card: { id: "c", state: "dev", title: "t", notes: ["raw string note", { text: "object note" }, { weird: 1 }] },
    doName: "d", to: "test",
  });
  assert.match(out, /- raw string note/);
  assert.match(out, /- object note/);
  assert.match(out, /- \{"weird":1\}/); // unknown shape → JSON, never crashes
});

test("appends role-specific extras when provided", () => {
  const out = composePrompt({
    role: "releaser",
    card: { id: "c", state: "done", title: "t" },
    doName: "d", to: "staging",
    extras: "deploy.staging: ./scripts/deploy.sh\nmode: first",
  });
  assert.match(out, /=== Role-specific ===/);
  assert.match(out, /deploy\.staging: \.\/scripts\/deploy\.sh/);
});

test("special chars in title/notes survive verbatim (the shell-escaping footgun build-prompt kills)", () => {
  const out = composePrompt({
    role: "developer",
    card: { id: "c", state: "dev", title: 'Fix `cmd` with "quotes" & $vars', notes: [{ text: 'path: a/b"c $x' }] },
    doName: "d", to: "test",
  });
  assert.match(out, /title: Fix `cmd` with "quotes" & \$vars/);
  assert.match(out, /path: a\/b"c \$x/);
});

test("handles a missing/empty card without throwing", () => {
  const out = composePrompt({ role: "developer", card: null, doName: "d", to: "test" });
  assert.match(out, /cardId: $/m);
  assert.match(out, /state: $/m);
  assert.match(out, /title: $/m);
});
