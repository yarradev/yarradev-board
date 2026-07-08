/*
 * advisor-prompt.test.mjs — GH #55: the inline advisor prompt must source `head` from the card's linked PR
 * (linked_head_sha), not from ctx (which is empty for tester-owned judgement stages).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeBuildAdvisorPrompt } from "../skills/yarradev-run/scripts/pass.mjs";

const lifecycle = { test: { advisors: [{ role: "code-reviewer", watch_paths: ["**"] }] } };

test("advisor prompt: head sourced from getCard().linked_head_sha when ctx.head is empty", async () => {
  const getCard = async (id) => ({ id, linked_head_sha: "abc123" });
  const build = makeBuildAdvisorPrompt(lifecycle, "acme:main", getCard);
  const path = await build({ id: "c1", state: "test", head: undefined }, "code-reviewer");
  const body = readFileSync(path, "utf8");
  assert.match(body, /head: abc123/);
  assert.match(body, /c1/); // instructs branch self-discovery by cardId (mentions the cardId)
});

test("advisor prompt: falls back to ctx.head when getCard returns null (no throw)", async () => {
  const getCard = async () => null;
  const build = makeBuildAdvisorPrompt(lifecycle, "acme:main", getCard);
  const path = await build({ id: "c2", state: "test", head: "ctxhead" }, "code-reviewer");
  assert.match(readFileSync(path, "utf8"), /head: ctxhead/);
});
