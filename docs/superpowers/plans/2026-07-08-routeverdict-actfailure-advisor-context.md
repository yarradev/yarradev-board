# #54 + #55 — Act-failure surfacing & advisor-context fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two correctness bugs in `pass.mjs` verdict routing: (#54) act failures silently reported as `"routed"` → surface them as a distinct `act_failed` outcome (+ escalate the half-advanced-epic case); (#55) the inline advisor prompt built with empty `repo/branch/head` for tester-owned stages → source `head` from the card's linked PR and have the advisor self-discover its branch.

**Architecture:** All in `pass.mjs`. #54 threads a new `actFailed` field out of `routeVerdict` and maps it in `reconcileVerdicts`. #55 makes `makeBuildAdvisorPrompt` async with an injected `getCard`. Two independent code tasks + a docs/version task.

**Tech Stack:** Node ESM (built-ins only). Test runner: `npm test`. Scoped: `node --test --test-name-pattern="<re>" test/<file>` (⚠️ `npm test -- --test-name-pattern` does NOT scope here).

## Global Constraints

- **Zero external deps.** No behavior change to the happy path or the existing `advisor_clear` / bounce-budget handling.
- **#54 is observability, not auto-retry** — the existing CLEAR_LEASE + decide-re-derive recovery still runs; the fix only makes a silently-failed act distinguishable from a real success.
- **`actFailed` shape:** `{ script: string, result: object|null }` (the failing act script name + the board result, or `null` if `run()` returned nothing). `null` when no act failed.
- **Reconcile outcome vocabulary:** `error` (reconcile-machinery throw) > `act_failed` (a board act returned `!ok`) > `routed` (success). Precedence in that order.
- **#55:** `head` sourced from `getEnriched(id).linked_head_sha`, falling back to `ctx.head ?? ""`; advisor self-discovers `branch` by `cardId`. `getCard` is the same `getEnriched`-backed function `reconcileVerdicts` already uses.

---

### Task 1: #54 — surface act failures in `routeVerdict` + `reconcileVerdicts`

**Files:**
- Modify: `skills/yarradev-run/scripts/pass.mjs` (`routeVerdict` — advance branch ~307-332, decomposed branch ~371-393; `reconcileVerdicts` outcome mapping ~660)
- Test: `test/pass-routing.test.mjs` (extend — `routeVerdict` unit tests; also extend the `route()` harness to expose `actFailed`), `test/pass-reconcile.test.mjs` (extend — outcome mapping) if the outcome mapping is tested there; otherwise add to pass-routing.

**Interfaces:**
- Produces: `routeVerdict(...)` return object gains an optional `actFailed: {script, result}|null` field (set in the advance + decomposed branches; absent/`null` elsewhere). `reconcileVerdicts` result `outcome` gains the value `"act_failed"`.

- [ ] **Step 1: Extend the test harness + write failing tests**

In `test/pass-routing.test.mjs`, extend the `route()` helper's return to expose `actFailed` (find the `return { acts: result.acts.map(...), dispatches: result.dispatches, ... }` and add `actFailed: result.actFailed ?? null`). Then add:

```js
test("routeVerdict: advance MOVE that 422s (not advisor_clear) → actFailed set, not silent", async () => {
  const r = await route({
    verdict: { status: "advance" },
    ctx: { id: "c1", to: "done", role: "tester", state: "test", gen: "1" },
    overrides: { run: async (script) => (script === "move.mjs" ? { ok: false, status: 422, outcome: "bad_act", reason: "no edge" } : { ok: true }) },
  });
  assert.ok(r.actFailed, "actFailed must be set on an unhandled MOVE failure");
  assert.equal(r.actFailed.script, "move.mjs");
});

test("routeVerdict: advance MOVE with advisor_clear 422 → NOT actFailed (handled path)", async () => {
  const r = await route({
    verdict: { status: "advance" },
    ctx: { id: "c1", to: "done", role: "tester", state: "test", gen: "1" },
    overrides: { run: async (script) => (script === "move.mjs" ? { ok: false, outcome: "gate_blocked", blocked_by: ["advisor_clear"] } : { ok: true }) },
  });
  assert.equal(r.actFailed, null, "advisor_clear is a handled reshape, not an act failure");
});

test("routeVerdict: happy advance → NOT actFailed", async () => {
  const r = await route({
    verdict: { status: "advance", summary: "ok" },
    ctx: { id: "c1", to: "done", role: "tester", state: "test", gen: "1" },
    overrides: { run: async () => ({ ok: true }) },
  });
  assert.equal(r.actFailed, null);
});

test("routeVerdict: decomposed barrier MOVE fails after CREATEs → actFailed + escalate", async () => {
  const r = await route({
    verdict: { status: "decomposed", children: [{ title: "child A" }] },
    ctx: { id: "epic1", to: "epic_decompose", role: "analyst", state: "epic_decompose", gen: "1" },
    overrides: { run: async (script) => (script === "move.mjs" ? { ok: false, status: 422, reason: "no edge" } : { ok: true }) },
  });
  assert.ok(r.actFailed, "barrier MOVE failure must set actFailed");
  assert.equal(r.actFailed.script, "move.mjs");
  assert.ok(r.acts.some(([s]) => s === "escalate.mjs"), "half-advanced epic must escalate");
});
```

- [ ] **Step 2: Run — verify they fail**

Run: `node --test --test-name-pattern="actFailed|advisor_clear 422 → NOT|happy advance → NOT|barrier MOVE fails" test/pass-routing.test.mjs`
Expected: FAIL — `actFailed` is undefined; no escalate on barrier failure.

- [ ] **Step 3: Implement in `routeVerdict`**

In `pass.mjs`, after `let spawnDeferred = 0;` (~line 288) add:

```js
  let actFailed = null;
```

**Advance branch** — after the `if (mv && mv.ok) {…} else if (advisor_clear) {…}` chain and its trailing comment, BEFORE `return { acts, dispatches, advisorClear422, spawnDeferred };` (~line 332), insert the failure detection, and add `actFailed` to that return:

```js
      // GH #54: an unhandled MOVE failure (not ok, not the advisor_clear reshape) must be surfaced, not
      // silently reported as "routed".
      if (!(mv && mv.ok) && !advisorClear422) {
        actFailed = { script: "move.mjs", result: mv ?? null };
      }
      return { acts, dispatches, advisorClear422, spawnDeferred, actFailed };
```

**Decomposed branch** — set `actFailed` on a CREATE failure, and check the barrier MOVE (~lines 384-393):

```js
        const r = await call("create.mjs", args);
        if (!r || !r.ok) {
          allCreated = false;
          actFailed = { script: "create.mjs", result: r ?? null }; // GH #54: partial decomposition surfaced
          break; // CREATE failure → stop issuing further CREATEs; next pass re-dispatches the analyst.
        }
      }
      if (allCreated) {
        const mvr = await call("move.mjs", [id, gen, ctx.to, ctx.role]); // advance the epic to the barrier stage
        if (!(mvr && mvr.ok)) {
          // GH #54: children were minted but the epic can't reach the barrier stage → inconsistent half-state.
          // Surface AND escalate (loud board signal), not a silent retry.
          actFailed = { script: "move.mjs", result: mvr ?? null };
          await call("escalate.mjs", [id, "decomposed: children created but barrier advance failed"]);
        }
      }
      return { acts, dispatches, advisorClear422, spawnDeferred, actFailed };
```

(Other `routeVerdict` return sites are unchanged; `actFailed` is absent → `reconcileVerdicts` reads `undefined` → falsy → `"routed"` as before.)

- [ ] **Step 4: Map the outcome in `reconcileVerdicts`**

In `pass.mjs` (~line 660), change the results.push outcome and include the detail:

```js
      results.push({
        verdictPath,
        cardId,
        outcome: r.error ? "error" : r.actFailed ? "act_failed" : "routed",
        advisorClear422: r.advisorClear422,
        ...(r.actFailed ? { actFailed: r.actFailed } : {}),
        ...(r.error ? { error: r.error } : {}),
      });
```

Immediately before that `results.push`, add a distinct log so it's visible in pass output (use the existing injected `logger`):

```js
      if (r.actFailed) {
        logger(`[pass] reconcile ${verdictPath}: act ${r.actFailed.script} FAILED (${r.actFailed.result?.reason ?? r.actFailed.result?.outcome ?? "no detail"}) — card NOT advanced`);
      }
```

(Confirm `logger` is the param name used elsewhere in `reconcileVerdicts`; if it's named differently, use that.)

- [ ] **Step 5: Run — verify pass**

Run: `node --test test/pass-routing.test.mjs`
Expected: PASS (new + all existing parity tests — the happy path and advisor_clear cases must still pass).

- [ ] **Step 6: Full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add skills/yarradev-run/scripts/pass.mjs test/pass-routing.test.mjs
git commit -m "fix(pass): surface swallowed act failures as act_failed outcome + escalate half-advanced epic (#54)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: #55 — source advisor `head` from the linked PR

**Files:**
- Modify: `skills/yarradev-run/scripts/pass.mjs` (`makeBuildAdvisorPrompt` ~847; its construction site in `main()` ~935; move `getCard` definition above that site)
- Test: `test/pass-routing.test.mjs` or a small new `test/advisor-prompt.test.mjs` (create) — unit-test `makeBuildAdvisorPrompt`

**Interfaces:**
- Consumes: a `getCard(id) => card|null` (the `getEnriched`-backed function) returning `{ linked_head_sha? }`.
- Produces: `makeBuildAdvisorPrompt(lifecycle, doName, getCard)` returns an **async** `(ctx, advisorRole) => promptPath`; the prompt's `head:` line is sourced from `linked_head_sha` (fallback `ctx.head ?? ""`), and it instructs the advisor to self-discover its branch by `cardId`.

- [ ] **Step 1: Write the failing test**

Create `test/advisor-prompt.test.mjs`:

```js
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
```

- [ ] **Step 2: Run — verify fail**

Run: `node --test test/advisor-prompt.test.mjs`
Expected: FAIL — `makeBuildAdvisorPrompt` ignores `getCard` (3rd arg) and is synchronous.

- [ ] **Step 3: Implement**

Replace `makeBuildAdvisorPrompt` (~847):

```js
/** Build the real advisor-prompt writer (the 422 async-dispatch path). Sources `head` from the card's linked
 * PR (GH #55 — ctx is empty for tester-owned stages); the advisor self-discovers its branch by cardId. */
export function makeBuildAdvisorPrompt(lifecycle, doName, getCard) {
  return async (ctx, advisorRole) => {
    const advisor = lifecycle?.[ctx.state]?.advisors?.find((a) => a?.role === advisorRole);
    const watchPaths = Array.isArray(advisor?.watch_paths) ? advisor.watch_paths : [];
    let head = ctx.head ?? "";
    try {
      const card = getCard ? await getCard(ctx.id) : null;
      if (card?.linked_head_sha) head = card.linked_head_sha;
    } catch {
      /* best-effort: fall back to ctx.head */
    }
    const lines = [
      "=== Advisor review ===",
      `doName: ${doName ?? ""}`,
      `cardId: ${ctx.id}`,
      `state: ${ctx.state}`,
      `repo: ${ctx.repo ?? ""}`,
      `head: ${head}`,
      `role: ${advisorRole}`,
      `watch_paths: ${JSON.stringify(watchPaths)}`,
      "",
      `Find the branch for card ${ctx.id} yourself (e.g. git branch -r --list 'origin/*${ctx.id}*'), review the`,
      "linked head above for this stage's concerns, then post a verdict: {status, head, reason?}.",
    ];
    const path = `/tmp/yarradev-prompt-${ctx.id}-${advisorRole}.txt`;
    writeFileSync(path, lines.join("\n") + "\n");
    return path;
  };
}
```

- [ ] **Step 4: Wire `getCard` into the construction site**

In `main()`, the `getCard` const is currently defined AFTER the `makeBuildAdvisorPrompt(...)` construction (~935). Move the `getCard` definition (the `const getCard = async (id) => { try { return await client.getEnriched(id); } catch { return null; } };` block) to ABOVE the `makeBuildAdvisorPrompt(...)` line, then change:

```js
  const buildAdvisorPrompt = makeBuildAdvisorPrompt(lifecycle, cfg.doName);
```
to:
```js
  const buildAdvisorPrompt = makeBuildAdvisorPrompt(lifecycle, cfg.doName, getCard);
```

(Verify `getCard` is not used above its new position by anything other than this; it's passed into `reconcileVerdicts` and `routeVerdict`, both after this point.)

- [ ] **Step 5: Run — verify pass + full suite**

Run: `node --test test/advisor-prompt.test.mjs` → PASS.
Run: `npm test` → PASS (the async `buildAdvisorPrompt` is already `await`ed at the `routeVerdict` call site, so the advisor_clear parity test still passes; if a routing test injects a synchronous `buildAdvisorPrompt`, that still works since `await` handles both).

- [ ] **Step 6: Commit**

```bash
git add skills/yarradev-run/scripts/pass.mjs test/advisor-prompt.test.mjs
git commit -m "fix(pass): source inline-advisor head from linked PR, self-discover branch (#55)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: SKILL.md failure-map note + version bump

**Files:**
- Modify: `skills/yarradev-run/SKILL.md` (failure map / reconcile outcomes; advisor-context note)
- Modify: `.claude-plugin/plugin.json` (→ `0.14.1`)

**Interfaces:** none (terminal docs/version task).

- [ ] **Step 1: Document the `act_failed` outcome + advisor sourcing**

In `skills/yarradev-run/SKILL.md`, find the failure-map / reconcile-outcomes documentation (search for `routed`, `no-parse`, or `dispatch_error` — the reconcile outcome vocabulary). Add a row/line for `act_failed`:

> `act_failed` — a posted MOVE/CREATE act returned `!ok` (e.g. a 422 bad-act or a crashed per-role token); the card was NOT advanced. Distinct from `error` (reconcile machinery threw) and `routed` (success). The `decomposed` barrier-advance failure also escalates.

And near the advisor-dispatch documentation, add a brief note: the inline advisor prompt sources `head` from the card's linked PR (`linked_head_sha`) and the advisor self-discovers its branch by `cardId` (repo/branch are not passed from the owner's dispatch context).

(Locate insertion points by content — do not trust line numbers.)

- [ ] **Step 2: Version bump**

In `.claude-plugin/plugin.json`, set `"version": "0.14.1"` (read current first — should be 0.14.0).

- [ ] **Step 3: Full suite + sanity**

Run: `npm test` → PASS.
Run: `node -e "import('./skills/yarradev-run/scripts/pass.mjs').then(m => console.log(typeof m.makeBuildAdvisorPrompt, typeof m.routeVerdict))"` → `function function`.

- [ ] **Step 4: Commit**

```bash
git add skills/yarradev-run/SKILL.md .claude-plugin/plugin.json
git commit -m "docs: document act_failed outcome + advisor head-sourcing (#54, #55, v0.14.1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- #54: check every unchecked MOVE/CREATE, distinct `act_failed` outcome, escalate the decomposed half-advance → Task 1. ✅
- #55: async `makeBuildAdvisorPrompt` sourcing head from linked PR + self-discover branch → Task 2. ✅
- SKILL.md failure-map + v0.14.1 → Task 3. ✅

**Placeholder scan:** none — full code in every code step; commands have expected output. The two "locate by content" notes (logger name, SKILL.md insertion) are explicit verification instructions.

**Type consistency:** `actFailed: {script, result}|null` is set identically in both branches, returned in both branch return objects, and read as `r.actFailed` in `reconcileVerdicts`; the `act_failed` outcome string is consistent across Task 1 and Task 3's doc. `makeBuildAdvisorPrompt(lifecycle, doName, getCard)` async signature matches the Task-4 construction site and the `await`ed call in `routeVerdict`.

**Ordering risk flagged:** Task 2 Step 4 moves `getCard` above the `makeBuildAdvisorPrompt` construction — the one non-obvious wiring hazard, called out explicitly.
