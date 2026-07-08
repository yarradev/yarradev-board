# #58 + #59 + #60 — Uniform act-failure escalation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every load-bearing act failure in `routeVerdict` both surface (`act_failed`, from #54) and park the card (`escalate.mjs`), uniformly — closing #58 (advance loops forever), #59 (reject/link-pr/push not surfaced), #60 (decomposed mid-loop CREATE doesn't escalate).

**Architecture:** One `failAct(script, result, reason)` closure inside `routeVerdict` (sets the existing `actFailed` let + calls `escalate.mjs`), applied across the advance / reject / submitted / decomposed branches. `reattach-ci` and other best-effort acts are untouched. No `reconcileVerdicts` change (its `act_failed` mapping from #54 already covers it).

**Tech Stack:** Node ESM. Test runner: `npm test`. Scoped: `node --test --test-name-pattern="<re>" test/<file>` (⚠️ `npm test -- --test-name-pattern` does NOT scope here).

## Global Constraints

- **Additive / fail-safe:** happy paths and already-handled special cases (advance `advisor_clear` reshape, reject bounce-budget) are unchanged. No happy success ever flips to `act_failed` or escalates.
- **Load-bearing acts escalate; best-effort acts don't.** Escalate: advance MOVE, reject MOVE (non-bounce), link-pr/push, decomposed CREATE, decomposed barrier MOVE. Do NOT escalate: `reattach-ci.mjs`, `note`, `advice`, `fingerprint`.
- **`actFailed` shape** (from #54): `{ script:string, result:object|null }`.
- Every branch that can now set `actFailed` must include it in its `return` object (advance + decomposed already do; **reject + submitted must be updated** — they currently return without it).

---

### Task 1: `failAct` helper + uniform application in `routeVerdict`

**Files:**
- Modify: `skills/yarradev-run/scripts/pass.mjs` (`routeVerdict`: add `failAct` near the top after `let actFailed = null`; apply in advance ~336, reject ~341-361, submitted ~363-374, decomposed ~391-405)
- Test: `test/pass-routing.test.mjs` (extend)

**Interfaces:**
- Produces: no signature change to `routeVerdict`; it now escalates on any load-bearing act failure and sets `actFailed` on the reject + submitted branches too.

- [ ] **Step 1: Write the failing tests**

Append to `test/pass-routing.test.mjs`:

```js
test("routeVerdict: advance MOVE fail (non-advisor_clear) → actFailed AND escalate (#58)", async () => {
  const r = await route({
    verdict: { status: "advance" },
    ctx: { id: "c1", to: "done", role: "tester", state: "test", gen: "1" },
    overrides: { run: async (s) => (s === "move.mjs" ? { ok: false, status: 422, reason: "no edge" } : { ok: true }) },
  });
  assert.ok(r.actFailed, "actFailed set");
  assert.ok(r.acts.some(([s]) => s === "escalate.mjs"), "advance failure now escalates (breaks the loop)");
});

test("routeVerdict: advance advisor_clear → still NO escalate, NO actFailed (regression)", async () => {
  const r = await route({
    verdict: { status: "advance" },
    ctx: { id: "c1", to: "done", role: "tester", state: "test", gen: "1" },
    overrides: { run: async (s) => (s === "move.mjs" ? { ok: false, outcome: "gate_blocked", blocked_by: ["advisor_clear"] } : { ok: true }) },
  });
  assert.equal(r.actFailed, null);
  assert.ok(!r.acts.some(([s]) => s === "escalate.mjs"));
});

test("routeVerdict: reject MOVE fail (non-bounce) → actFailed + escalate (#59)", async () => {
  const r = await route({
    verdict: { status: "reject", to: "dev" },
    ctx: { id: "c1", role: "tester", state: "test", gen: "1" },
    overrides: { run: async (s) => (s === "reject.mjs" ? { ok: false, status: 422, reason: "bad edge" } : { ok: true }) },
  });
  assert.ok(r.actFailed, "reject failure surfaced");
  assert.ok(r.acts.some(([s]) => s === "escalate.mjs"), "reject failure escalates");
});

test("routeVerdict: reject bounce-budget → its OWN escalate, actFailed NOT set as a generic failure (regression)", async () => {
  const r = await route({
    verdict: { status: "reject", to: "dev" },
    ctx: { id: "c1", role: "tester", state: "test", gen: "1" },
    overrides: { run: async (s) => (s === "reject.mjs" ? { ok: false, outcome: "gate_blocked", blocked_by: ["bounce budget"] } : { ok: true }) },
  });
  // exactly one escalate (the bounce-budget path), not doubled:
  assert.equal(r.acts.filter(([s]) => s === "escalate.mjs").length, 1);
});

test("routeVerdict: submitted link-pr fail → actFailed + escalate; reattach-ci stays best-effort (#59)", async () => {
  const r = await route({
    verdict: { status: "submitted", evidence: { repo: "o/r", pr_number: 5, head: "h" } },
    ctx: { id: "c1", role: "developer", state: "dev", gen: "1", kind: "work" },
    overrides: { run: async (s) => (s === "link-pr.mjs" ? { ok: false, status: 422 } : { ok: true }) },
  });
  assert.ok(r.actFailed, "link-pr failure surfaced");
  assert.ok(r.acts.some(([s]) => s === "escalate.mjs"), "link-pr failure escalates");
});

test("routeVerdict: submitted all-ok → no escalate, no actFailed (regression)", async () => {
  const r = await route({
    verdict: { status: "submitted", evidence: { repo: "o/r", pr_number: 5, head: "h" } },
    ctx: { id: "c1", role: "developer", state: "dev", gen: "1", kind: "work" },
    overrides: { run: async () => ({ ok: true }) },
  });
  assert.equal(r.actFailed, null);
  assert.ok(!r.acts.some(([s]) => s === "escalate.mjs"));
});

test("routeVerdict: decomposed mid-loop CREATE fail → actFailed + escalate (#60)", async () => {
  let n = 0;
  const r = await route({
    verdict: { status: "decomposed", children: [{ title: "a" }, { title: "b" }] },
    ctx: { id: "epic1", to: "epic_decompose", role: "analyst", state: "epic_decompose", gen: "1" },
    overrides: { run: async (s) => (s === "create.mjs" ? { ok: (++n === 1) } : { ok: true }) }, // first CREATE ok, second fails
  });
  assert.ok(r.actFailed, "partial CREATE failure surfaced");
  assert.ok(r.acts.some(([s]) => s === "escalate.mjs"), "partial decompose escalates (no re-decompose dup)");
});
```

- [ ] **Step 2: Run — verify they fail**

Run: `node --test --test-name-pattern="#58|#59|#60|bounce-budget → its OWN|submitted all-ok|advisor_clear → still" test/pass-routing.test.mjs`
Expected: FAIL — reject/submitted/decomposed-CREATE failures don't escalate yet; reject/submitted don't set actFailed.

- [ ] **Step 3: Add the `failAct` helper**

In `routeVerdict`, right after `let actFailed = null;` (and after the `call` helper is defined — `failAct` uses `call`, `id`, and mutates `actFailed`), add:

```js
  /** Load-bearing act failed → surface (act_failed) AND park (escalate). Uniform across branches (#58/#59/#60). */
  const failAct = async (script, result, reason) => {
    actFailed = { script, result: result ?? null };
    await call("escalate.mjs", [id, reason]);
  };
```

- [ ] **Step 4: Apply in the advance branch (#58)**

Replace the advance branch's failure block (currently sets `actFailed` only, ~line 335-337):

```js
      if (!(mv && mv.ok) && !advisorClear422) {
        actFailed = { script: "move.mjs", result: mv ?? null };
      }
```
with:
```js
      if (!(mv && mv.ok) && !advisorClear422) {
        await failAct("move.mjs", mv, `advance act failed (${ctx.state}→${ctx.to}): ${mv?.reason ?? mv?.outcome ?? "no detail"}`);
      }
```

- [ ] **Step 5: Apply in the reject branch (#59)**

Replace the reject branch body (~341-360). Current:

```js
    if (status === "reject") {
      if (verdict.to != null) {
        const r = await call("reject.mjs", [id, gen, verdict.to, ctx.role]);
        if (r && !r.ok && isBounceBudget(r)) {
          await call("escalate.mjs", [id, `bounce budget: ${ctx.state}→${verdict.to}`]);
        }
      } else {
        const derivedTo = rejectTargetOf(machine, ctx.state);
        if (derivedTo != null) {
          await call("reject.mjs", [id, gen, derivedTo, ctx.role]);
        } else {
          await call("escalate.mjs", [id, `reject edge ambiguous for state ${ctx.state}`]);
        }
      }
      return { acts, dispatches, advisorClear422, spawnDeferred };
    }
```
with (check both reject.mjs results; bounce-budget keeps its dedicated message; other failures → failAct; add `actFailed` to the return):

```js
    if (status === "reject") {
      if (verdict.to != null) {
        const r = await call("reject.mjs", [id, gen, verdict.to, ctx.role]);
        if (r && !r.ok) {
          if (isBounceBudget(r)) await call("escalate.mjs", [id, `bounce budget: ${ctx.state}→${verdict.to}`]);
          else await failAct("reject.mjs", r, `reject act failed (${ctx.state}→${verdict.to}): ${r?.reason ?? r?.outcome ?? "no detail"}`);
        }
      } else {
        const derivedTo = rejectTargetOf(machine, ctx.state);
        if (derivedTo != null) {
          const r = await call("reject.mjs", [id, gen, derivedTo, ctx.role]);
          if (r && !r.ok) {
            if (isBounceBudget(r)) await call("escalate.mjs", [id, `bounce budget: ${ctx.state}→${derivedTo}`]);
            else await failAct("reject.mjs", r, `advisor reject act failed (${ctx.state}→${derivedTo}): ${r?.reason ?? r?.outcome ?? "no detail"}`);
          }
        } else {
          await call("escalate.mjs", [id, `reject edge ambiguous for state ${ctx.state}`]);
        }
      }
      return { acts, dispatches, advisorClear422, spawnDeferred, actFailed };
    }
```

- [ ] **Step 6: Apply in the submitted branch (#59)**

In the submitted branch, capture the `link-pr.mjs`/`push.mjs` results and `failAct` on failure; leave `reattach-ci.mjs` best-effort; add `actFailed` to the return. Current:

```js
      if (ctx.kind === "respawn") {
        await call("push.mjs", [id, gen, repo, pr, head]);
      } else {
        await call("link-pr.mjs", [id, gen, repo, pr, head]);
      }
      await call("reattach-ci.mjs", [id, repo, pr, head]);
      return { acts, dispatches, advisorClear422, spawnDeferred };
```
with:
```js
      const submit = ctx.kind === "respawn"
        ? await call("push.mjs", [id, gen, repo, pr, head])
        : await call("link-pr.mjs", [id, gen, repo, pr, head]);
      if (!(submit && submit.ok)) {
        await failAct(ctx.kind === "respawn" ? "push.mjs" : "link-pr.mjs", submit, `submit act failed for ${id}: ${submit?.reason ?? submit?.outcome ?? "no detail"}`);
      }
      await call("reattach-ci.mjs", [id, repo, pr, head]); // best-effort CI recovery — never escalate
      return { acts, dispatches, advisorClear422, spawnDeferred, actFailed };
```

- [ ] **Step 7: Apply in the decomposed branch (#60 + refactor barrier)**

In the decomposed branch, use `failAct` for the mid-loop CREATE failure (#60) and refactor the barrier-MOVE failure to `failAct`. Current:

```js
        const r = await call("create.mjs", args);
        if (!r || !r.ok) {
          allCreated = false;
          actFailed = { script: "create.mjs", result: r ?? null };
          break;
        }
      }
      if (allCreated) {
        const mvr = await call("move.mjs", [id, gen, ctx.to, ctx.role]);
        if (!(mvr && mvr.ok)) {
          actFailed = { script: "move.mjs", result: mvr ?? null };
          await call("escalate.mjs", [id, "decomposed: children created but barrier advance failed"]);
        }
      }
```
with:
```js
        const r = await call("create.mjs", args);
        if (!r || !r.ok) {
          allCreated = false;
          await failAct("create.mjs", r, "decompose CREATE failed mid-loop (partial children) — parking to avoid re-decompose duplicates");
          break;
        }
      }
      if (allCreated) {
        const mvr = await call("move.mjs", [id, gen, ctx.to, ctx.role]);
        if (!(mvr && mvr.ok)) {
          await failAct("move.mjs", mvr, "decomposed: children created but barrier advance failed");
        }
      }
```

- [ ] **Step 8: Run the tests**

Run: `node --test test/pass-routing.test.mjs`
Expected: PASS — new escalate cases + all pre-existing parity/act_failed tests (happy paths, advisor_clear, bounce-budget must remain green).

- [ ] **Step 9: Full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add skills/yarradev-run/scripts/pass.mjs test/pass-routing.test.mjs
git commit -m "fix(pass): uniform act-failure escalation across routeVerdict (#58, #59, #60)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: SKILL.md failure-map + version bump

**Files:**
- Modify: `skills/yarradev-run/SKILL.md` (the `act_failed` failure-map row)
- Modify: `.claude-plugin/plugin.json` (→ `0.14.3`)

- [ ] **Step 1: Broaden the `act_failed` failure-map row**

In `skills/yarradev-run/SKILL.md`, find the `act_failed` row (search `act_failed`). It currently scopes coverage to "advance MOVE and decomposed CREATE/barrier acts (reject/link-pr/push not yet covered)". Replace that scoping clause with: coverage is now **all load-bearing reconcile-time acts** (advance/reject/link-pr/push/create/barrier), each of which **also escalates** (parks the card) on failure to prevent an infinite loud re-dispatch loop; `reattach-ci` and other best-effort acts stay non-fatal (not escalated). Keep the rest of the row (the `error`/`routed` distinction) intact.

- [ ] **Step 2: Version bump**

In `.claude-plugin/plugin.json`, set `"version": "0.14.3"` (read current first — should be 0.14.2).

- [ ] **Step 3: Full suite + sanity**

Run: `npm test` → PASS.
Run: `node -e "import('./skills/yarradev-run/scripts/pass.mjs').then(m => console.log(typeof m.routeVerdict))"` → `function`.

- [ ] **Step 4: Commit**

```bash
git add skills/yarradev-run/SKILL.md .claude-plugin/plugin.json
git commit -m "docs: broaden act_failed coverage in failure-map (#58/#59/#60, v0.14.3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** advance escalate (#58) → Task 1 Step 4; reject + link-pr/push surface+escalate (#59) → Steps 5-6; decomposed mid-loop CREATE escalate (#60) → Step 7; barrier refactor to failAct → Step 7; best-effort reattach-ci untouched → Step 6; SKILL.md + version → Task 2. ✅

**Placeholder scan:** none — full before/after code in every step; commands have expected output.

**Type consistency:** `failAct(script, result, reason)` sets `actFailed` in the same `{script, result}` shape #54/`reconcileVerdicts` already read; all branches that can set it now include `actFailed` in their return (advance + decomposed already did; reject + submitted returns updated in Steps 5-6). `isBounceBudget`/`rejectTargetOf` are existing helpers, unchanged.

**Regression guards baked into tests:** advisor_clear (no escalate), bounce-budget (exactly one escalate, not doubled), submitted-all-ok (no escalate) — the three most likely false-positive/double-escalate spots.
