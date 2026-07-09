# Runner Status Board (`yarradev watch`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live, card-centric status board (`yarradev watch`) that shows which cards the daemon is working right now and what just happened to each, assembled entirely from local daemon state.

**Architecture:** The daemon already captures each pass child's stdout but discards it after counting routed verdicts. We parse that stdout into per-card activity events, fold them into an in-memory TTL'd map on the daemon, expose the assembled board at `GET /board`, and add a `watch` CLI command that polls and redraws it. Four new pure functions + one additive `pass.mjs` enrichment + wiring.

**Tech Stack:** Node ≥ v24 built-ins only (ESM, `node:http`, `node:test`). Zero new dependencies. Existing patterns: pure helpers in `runner/*.mjs`, route table in `runner/control-plane.mjs`, CLI dispatch in `bin/yarradev.mjs`.

## Global Constraints

- **Zero new dependencies** — Node built-ins only.
- **Zero board API calls in the board path** — assemble from local state only (dispatch manifest + captured pass activity). No `getEnriched`/`listCards`.
- **Pure functions are clock-free** — callers pass `now`/`at`; never call `Date.now()` inside a pure helper.
- **Additive only to `pass.mjs` output** — add fields to emitted JSON lines; never rename/remove (the `verdicts` counter and existing shape assertions must keep working).
- **ESM, no top-level side effects on import** — CLI bodies stay guarded by `import.meta.url`.
- **Test command:** `node --test "test/<file>.test.mjs"` for one file; `node --test "test/*.test.mjs"` for all.

---

## Event shape (the contract all tasks share)

A single per-card activity event:

```js
{
  cardId: string,
  role: string | null,     // present on dispatch; null on reconcile/sync (filled from manifest downstream)
  state: string | null,    // dispatch: card.state; reconcile: ctx.state
  to: string | null,       // dispatch: card.to; reconcile: ctx.to
  event: "dispatched" | "reconcile" | "sync" | "skipped",
  outcome: string | null,  // reconcile outcome ("routed"|"act_failed"|"skipped"|"dispatch_error"|"no-parse"|"error"); sync kind
  detail: string | null,   // e.g. "429 transient", "dev→test", a skip reason
  at: number,              // ingest epoch ms (supplied by caller)
}
```

A board row (what `/board` returns and `renderBoard` consumes):

```js
{ cardId: string, role: string, state: string, ageS: number | null, last: string }
```

---

## Task 1: Enrich `pass.mjs` emitted lines (the one `pass.mjs` touch)

**Files:**
- Modify: `skills/yarradev-run/scripts/pass.mjs` (`dispatchNew` dispatched push; `reconcileVerdicts` main results push)
- Test: `test/pass-dispatch.test.mjs` (update existing deepEqual), `test/pass-reconcile.test.mjs` (new assertion)

**Interfaces:**
- Produces: `dispatchNew(...)` `dispatched[]` entries now `{ role, cardId, to, state, promptFile, verdictPath }`. `reconcileVerdicts(...)` routed/act_failed/error result objects now include `state` and `to` (from the dispatch context). These feed Task 2's `parsePassActivity`.

- [ ] **Step 1: Update the failing deepEqual test for the new dispatched shape**

In `test/pass-dispatch.test.mjs`, the test `"dispatchNew: full chain per card …"` asserts the exact dispatched entry. Replace the assertion block (currently lines ~142-144):

```js
  assert.deepEqual(out.dispatched, [
    { role: "designer", cardId: "c1", to: "dev", state: "spec", promptFile: "/tmp/prompt-c1.txt", verdictPath: "/v/c1" },
  ]);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/pass-dispatch.test.mjs`
Expected: FAIL — actual dispatched entry lacks `to`/`state`.

- [ ] **Step 3: Add `to`/`state` to the dispatched push**

In `skills/yarradev-run/scripts/pass.mjs`, in `dispatchNew`, find:

```js
      dispatched.push({ role: card.role, cardId: card.id, promptFile, verdictPath });
```

Replace with:

```js
      dispatched.push({ role: card.role, cardId: card.id, to: card.to, state: card.state, promptFile, verdictPath });
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/pass-dispatch.test.mjs`
Expected: PASS.

- [ ] **Step 5: Add a failing test for `state`/`to` on the reconcile result**

Append to `test/pass-reconcile.test.mjs`:

```js
test("reconcileVerdicts: routed result carries the dispatch context's state/to (for the status board)", async () => {
  const manifest = JSON.stringify({ status: "done", cardId: "c1", verdictPath: "/v/c1", role: "developer" });
  const context = JSON.stringify({ verdictPath: "/v/c1", ctx: { state: "dev", to: "test", kind: "work", gen: 5 } });
  const results = await reconcileVerdicts({
    manifestContent: manifest,
    consumedContent: "",
    contextContent: context,
    lifecycle: {},
    machine: { transitions: [] },
    run: async (script) => (script === "claim.mjs" ? { ok: true, gen: 5 } : { ok: true, status: 202, outcome: "committed" }),
    dispatch: async () => "/v/next",
    getCard: async () => ({ id: "c1", current_gen: 5 }),
    buildAdvisorPrompt: async () => "/tmp/p",
    readVerdict: async () => '```json\n{"status":"advance"}\n```',
    appendConsumed: async () => {},
    readContext: async () => ({ state: "dev", to: "test", kind: "work", gen: 5 }),
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, "routed");
  assert.equal(results[0].state, "dev");
  assert.equal(results[0].to, "test");
});
```

Ensure the file imports `reconcileVerdicts` (add to the existing import from `../skills/yarradev-run/scripts/pass.mjs` if absent).

- [ ] **Step 6: Run it to verify it fails**

Run: `node --test test/pass-reconcile.test.mjs`
Expected: FAIL — `results[0].state` is `undefined`.

- [ ] **Step 7: Add `state`/`to` to the reconcile main results push**

In `skills/yarradev-run/scripts/pass.mjs`, in `reconcileVerdicts`, find the main push after `routeVerdict` (the one with `outcome: r.error ? "error" : r.actFailed ? "act_failed" : "routed"`):

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

Add `state`/`to` from the in-scope `ctx`:

```js
      results.push({
        verdictPath,
        cardId,
        outcome: r.error ? "error" : r.actFailed ? "act_failed" : "routed",
        advisorClear422: r.advisorClear422,
        state: ctx.state ?? null,
        to: ctx.to ?? null,
        ...(r.actFailed ? { actFailed: r.actFailed } : {}),
        ...(r.error ? { error: r.error } : {}),
      });
```

- [ ] **Step 8: Run reconcile + full suite to verify no regressions**

Run: `node --test test/pass-reconcile.test.mjs && node --test "test/*.test.mjs"`
Expected: PASS (all; the two skipped live-board tests stay skipped).

- [ ] **Step 9: Commit**

```bash
git add skills/yarradev-run/scripts/pass.mjs test/pass-dispatch.test.mjs test/pass-reconcile.test.mjs
git commit -m "feat(pass): surface state/to on dispatch+reconcile lines for the status board"
```

---

## Task 2: `parsePassActivity` + activity-map helpers

**Files:**
- Create: `skills/yarradev-run/scripts/runner/pass-activity.mjs`
- Test: `test/runner-pass-activity.test.mjs`

**Interfaces:**
- Consumes: `isTransientActFailure` from `../pass.mjs` (Task from #65, already shipped) to label act-failures transient vs deterministic.
- Produces:
  - `parsePassActivity(stdout: string, at: number) → event[]`
  - `applyEvents(map: Map<string,event>, events: event[]) → void` (mutates; last-per-card wins)
  - `pruneActivity(map: Map<string,event>, now: number, opts?: {ttlMs?: number, cap?: number}) → void` (mutates)

- [ ] **Step 1: Write the failing tests**

Create `test/runner-pass-activity.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePassActivity, applyEvents, pruneActivity } from "../skills/yarradev-run/scripts/runner/pass-activity.mjs";

const AT = 1000;

test("parsePassActivity: dispatch line → one dispatched event per card", () => {
  const line = JSON.stringify({ phase: "dispatch", dispatched: [
    { role: "designer", cardId: "c1", to: "dev", state: "spec", promptFile: "/p", verdictPath: "/v" },
  ], skipped: [{ cardId: "c9", reason: "claim 409: fenced" }] });
  const events = parsePassActivity(line, AT);
  assert.deepEqual(events.find((e) => e.cardId === "c1"), {
    cardId: "c1", role: "designer", state: "spec", to: "dev", event: "dispatched", outcome: null, detail: null, at: AT,
  });
  const s = events.find((e) => e.cardId === "c9");
  assert.equal(s.event, "skipped");
  assert.equal(s.detail, "claim 409: fenced");
});

test("parsePassActivity: reconcile routed → carries the edge in detail", () => {
  const line = JSON.stringify({ phase: "reconcile", cardId: "c3", outcome: "routed", state: "dev", to: "test" });
  const [e] = parsePassActivity(line, AT);
  assert.equal(e.event, "reconcile");
  assert.equal(e.outcome, "routed");
  assert.equal(e.detail, "dev→test");
});

test("parsePassActivity: reconcile act_failed → detail flags transient vs deterministic", () => {
  const transient = JSON.stringify({ phase: "reconcile", cardId: "c4", outcome: "act_failed", state: "dev", to: "test", actFailed: { script: "link-pr.mjs", result: { status: 429 } } });
  const deterministic = JSON.stringify({ phase: "reconcile", cardId: "c5", outcome: "act_failed", state: "dev", to: "test", actFailed: { script: "link-pr.mjs", result: { status: 422 } } });
  assert.equal(parsePassActivity(transient, AT)[0].detail, "429 transient");
  assert.equal(parsePassActivity(deterministic, AT)[0].detail, "422 parked");
});

test("parsePassActivity: sync line → sync event keyed by id; malformed lines skipped", () => {
  const stdout = [
    "not json",
    JSON.stringify({ phase: "sync", kind: "escalate", id: "c7" }),
    "{ broken",
  ].join("\n");
  const events = parsePassActivity(stdout, AT);
  assert.equal(events.length, 1);
  assert.equal(events[0].cardId, "c7");
  assert.equal(events[0].event, "sync");
  assert.equal(events[0].outcome, "escalate");
});

test("parsePassActivity: pass-level 'action:skipped' dispatch line yields no per-card event", () => {
  const line = JSON.stringify({ phase: "dispatch", action: "skipped", reason: "at-capacity" });
  assert.deepEqual(parsePassActivity(line, AT), []);
});

test("applyEvents: last event per card wins", () => {
  const m = new Map();
  applyEvents(m, [{ cardId: "c1", event: "dispatched", at: 1 }]);
  applyEvents(m, [{ cardId: "c1", event: "reconcile", outcome: "routed", at: 2 }]);
  assert.equal(m.get("c1").event, "reconcile");
});

test("pruneActivity: drops entries older than ttl, then LRU-caps", () => {
  const m = new Map();
  for (let i = 0; i < 5; i++) m.set("c" + i, { cardId: "c" + i, at: 1000 + i });
  m.set("old", { cardId: "old", at: 1 });
  pruneActivity(m, 2000, { ttlMs: 500, cap: 3 });
  assert.ok(!m.has("old"), "old (ttl-expired) dropped");
  assert.equal(m.size, 3, "capped to 3");
  assert.ok(m.has("c4") && m.has("c3") && m.has("c2"), "keeps the newest by at");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/runner-pass-activity.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `skills/yarradev-run/scripts/runner/pass-activity.mjs`:

```js
// skills/yarradev-run/scripts/runner/pass-activity.mjs
// Parse a pass child's stdout (the {phase:...} JSON lines) into per-card activity events, and
// maintain a bounded, TTL'd activity map the status board reads. All pure/clock-free (caller
// supplies `at`/`now`).
import { isTransientActFailure } from "../pass.mjs";

/** Label an act_failed reconcile line's detail: "<status> transient" | "<status> parked". */
function actFailedDetail(j) {
  const result = j?.actFailed?.result ?? null;
  const status = result?.status;
  const transient = isTransientActFailure(result);
  const kind = transient ? "transient" : "parked";
  return status != null ? `${status} ${kind}` : kind;
}

/**
 * Fold a pass's stdout into per-card events. Tolerates non-JSON / malformed lines (skips them).
 * @param {string} stdout
 * @param {number} at epoch ms stamped on every event (caller-supplied, clock-free)
 * @returns {Array<object>}
 */
export function parsePassActivity(stdout, at) {
  const events = [];
  for (const line of (stdout ?? "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let j;
    try { j = JSON.parse(t); } catch { continue; }
    if (!j || typeof j !== "object") continue;

    if (j.phase === "dispatch") {
      for (const d of Array.isArray(j.dispatched) ? j.dispatched : []) {
        if (d?.cardId == null) continue;
        events.push({ cardId: String(d.cardId), role: d.role ?? null, state: d.state ?? null, to: d.to ?? null, event: "dispatched", outcome: null, detail: null, at });
      }
      for (const s of Array.isArray(j.skipped) ? j.skipped : []) {
        if (s?.cardId == null) continue;
        events.push({ cardId: String(s.cardId), role: null, state: null, to: null, event: "skipped", outcome: "skipped", detail: s.reason ?? null, at });
      }
      // pass-level {action:"skipped"} lines (breaker-open / at-capacity) carry no cardId → ignored
    } else if (j.phase === "reconcile") {
      if (j.cardId == null) continue;
      const edge = j.state != null && j.to != null ? `${j.state}→${j.to}` : null;
      const detail = j.outcome === "act_failed" ? actFailedDetail(j) : edge;
      events.push({ cardId: String(j.cardId), role: null, state: j.state ?? null, to: j.to ?? null, event: "reconcile", outcome: j.outcome ?? null, detail, at });
    } else if (j.phase === "sync") {
      if (j.id == null) continue;
      events.push({ cardId: String(j.id), role: null, state: null, to: null, event: "sync", outcome: j.kind ?? null, detail: null, at });
    }
  }
  return events;
}

/** Fold events into the map; last event per card wins (events are in emission order). */
export function applyEvents(map, events) {
  for (const e of events ?? []) map.set(e.cardId, e);
}

/** Drop entries older than ttlMs, then LRU-cap by `at` (oldest dropped first). Mutates. */
export function pruneActivity(map, now, { ttlMs = 600_000, cap = 50 } = {}) {
  for (const [k, e] of map) {
    if (now - (e?.at ?? 0) > ttlMs) map.delete(k);
  }
  if (map.size > cap) {
    const sorted = [...map.entries()].sort((a, b) => (a[1]?.at ?? 0) - (b[1]?.at ?? 0));
    for (let i = 0; i < map.size - cap; i++) map.delete(sorted[i][0]);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/runner-pass-activity.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add skills/yarradev-run/scripts/runner/pass-activity.mjs test/runner-pass-activity.test.mjs
git commit -m "feat(runner): parse pass activity into a bounded TTL'd per-card map"
```

---

## Task 3: `assembleBoard` (join manifest ⋈ activity)

**Files:**
- Modify: `skills/yarradev-run/scripts/runner/state.mjs` (add `assembleBoard`)
- Test: `test/runner-state-board.test.mjs`

**Interfaces:**
- Consumes: `inflightRows(manifestContent, now, staleS)` (existing in `state.mjs`).
- Produces: `assembleBoard({ activityMap, manifestContent, now, staleS }) → row[]` where row is `{ cardId, role, state, ageS, last }`.

- [ ] **Step 1: Write the failing tests**

Create `test/runner-state-board.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleBoard } from "../skills/yarradev-run/scripts/runner/state.mjs";

const NOW = 100_000;
const iso = (ms) => new Date(ms).toISOString();

test("assembleBoard: in-flight cards render as in-flight/dispatched with age from the manifest", () => {
  const manifest = JSON.stringify({ status: "pending", cardId: "c1", role: "designer", verdictPath: "/v1", dispatchedAt: iso(NOW - 12_000) });
  const rows = assembleBoard({ activityMap: new Map(), manifestContent: manifest, now: NOW, staleS: 7200 });
  assert.deepEqual(rows, [{ cardId: "c1", role: "designer", state: "in-flight", ageS: 12, last: "dispatched" }]);
});

test("assembleBoard: a resolved (advanced) card not in flight is overlaid from the activity map", () => {
  const activity = new Map([["c3", { cardId: "c3", role: null, state: "dev", to: "test", event: "reconcile", outcome: "routed", detail: "dev→test", at: NOW - 2000 }]]);
  const rows = assembleBoard({ activityMap: activity, manifestContent: "", now: NOW, staleS: 7200 });
  assert.deepEqual(rows, [{ cardId: "c3", role: "-", state: "advanced", ageS: 2, last: "dev→test" }]);
});

test("assembleBoard: transient act_failed → 'retrying'; deterministic → 'ESCALATED'; escalate sync → 'ESCALATED'", () => {
  const activity = new Map([
    ["t", { cardId: "t", role: null, event: "reconcile", outcome: "act_failed", detail: "429 transient", at: NOW - 1000 }],
    ["d", { cardId: "d", role: null, event: "reconcile", outcome: "act_failed", detail: "422 parked", at: NOW - 1000 }],
    ["e", { cardId: "e", role: null, event: "sync", outcome: "escalate", detail: null, at: NOW - 1000 }],
  ]);
  const rows = assembleBoard({ activityMap: activity, manifestContent: "", now: NOW, staleS: 7200 });
  const byId = Object.fromEntries(rows.map((r) => [r.cardId, r]));
  assert.equal(byId.t.state, "retrying");
  assert.equal(byId.d.state, "ESCALATED");
  assert.equal(byId.e.state, "ESCALATED");
});

test("assembleBoard: in-flight first (oldest first), then resolved (newest first); in-flight wins over a stale activity entry", () => {
  const manifest = [
    JSON.stringify({ status: "pending", cardId: "old", role: "developer", verdictPath: "/vo", dispatchedAt: iso(NOW - 30_000) }),
    JSON.stringify({ status: "pending", cardId: "new", role: "tester", verdictPath: "/vn", dispatchedAt: iso(NOW - 5_000) }),
  ].join("\n");
  const activity = new Map([
    ["old", { cardId: "old", event: "dispatched", at: NOW - 30_000 }], // superseded by in-flight row
    ["r1", { cardId: "r1", event: "reconcile", outcome: "routed", detail: "a→b", at: NOW - 8_000 }],
    ["r2", { cardId: "r2", event: "reconcile", outcome: "routed", detail: "c→d", at: NOW - 1_000 }],
  ]);
  const rows = assembleBoard({ activityMap: activity, manifestContent: manifest, now: NOW, staleS: 7200 });
  assert.deepEqual(rows.map((r) => r.cardId), ["old", "new", "r2", "r1"]);
  assert.equal(rows.filter((r) => r.cardId === "old").length, 1, "in-flight card not duplicated");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/runner-state-board.test.mjs`
Expected: FAIL — `assembleBoard` not exported.

- [ ] **Step 3: Implement `assembleBoard`**

Append to `skills/yarradev-run/scripts/runner/state.mjs`:

```js
/** Map an activity-map entry to the board's {state, last} for a card that is NOT currently in-flight. */
function overlayFor(e) {
  if (e.event === "reconcile") {
    if (e.outcome === "routed") return { state: "advanced", last: e.detail ?? "routed" };
    if (e.outcome === "act_failed") {
      const transient = typeof e.detail === "string" && e.detail.endsWith("transient");
      return { state: transient ? "retrying" : "ESCALATED", last: e.detail ?? "act_failed" };
    }
    return { state: e.outcome ?? "reconcile", last: e.detail ?? e.outcome ?? "" };
  }
  if (e.event === "sync") return { state: e.outcome === "escalate" ? "ESCALATED" : (e.outcome ?? "sync"), last: e.detail ?? "" };
  if (e.event === "skipped") return { state: "skipped", last: e.detail ?? "" };
  return { state: e.event ?? "?", last: e.detail ?? "" }; // lone "dispatched" that's no longer in-flight
}

/**
 * Assemble the live status board from LOCAL state only (no board API): in-flight cards from the
 * dispatch manifest, overlaid with recently-resolved/escalated cards from the activity map.
 * In-flight first (oldest first), then resolved (newest first). Row: {cardId, role, state, ageS, last}.
 */
export function assembleBoard({ activityMap, manifestContent, now, staleS }) {
  const inflight = inflightRows(manifestContent, now, staleS);
  const inflightIds = new Set(inflight.map((r) => r.cardId));
  const rows = inflight
    .slice()
    .sort((a, b) => (b.ageS ?? 0) - (a.ageS ?? 0)) // oldest in-flight first
    .map((r) => ({ cardId: r.cardId, role: r.role ?? "-", state: "in-flight", ageS: r.ageS, last: "dispatched" }));

  const resolved = [];
  for (const [cardId, e] of activityMap ?? new Map()) {
    if (inflightIds.has(cardId)) continue; // in-flight row wins
    const { state, last } = overlayFor(e);
    resolved.push({ cardId, role: e.role ?? "-", state, ageS: Math.round((now - (e.at ?? now)) / 1000), last, _at: e.at ?? 0 });
  }
  resolved.sort((a, b) => b._at - a._at); // newest resolved first
  for (const r of resolved) { delete r._at; rows.push(r); }
  return rows;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/runner-state-board.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add skills/yarradev-run/scripts/runner/state.mjs test/runner-state-board.test.mjs
git commit -m "feat(runner): assembleBoard joins manifest in-flight with activity overlay"
```

---

## Task 4: Daemon wiring — `spawnPass` returns events; daemon holds the activity map

**Files:**
- Modify: `skills/yarradev-run/scripts/runner/daemon.mjs`
- Test: `test/runner-daemon.test.mjs` (add cases), `test/runner-spawnpass.test.mjs` (update if it deep-equals the resolve shape)

**Interfaces:**
- Consumes: `parsePassActivity`, `applyEvents`, `pruneActivity` (Task 2).
- Produces: `spawnPass(...)` now resolves `{ ok, verdicts, events, error? }`. `createDaemon({..., activityTtlMs?, activityCap?})` gains `getActivity() → Map`.

- [ ] **Step 1: Write the failing test for `getActivity`**

Append to `test/runner-daemon.test.mjs`:

```js
import { createDaemon } from "../skills/yarradev-run/scripts/runner/daemon.mjs";

test("createDaemon folds pass events into an activity map exposed via getActivity()", async () => {
  const events = [{ cardId: "c1", event: "reconcile", outcome: "routed", detail: "dev→test", at: 1 }];
  const daemon = createDaemon({ runPass: async () => ({ ok: true, verdicts: 1, events }), intervalMs: 1000, now: () => 5 });
  await daemon.requestTick();
  await daemon._drain();
  assert.equal(daemon.getActivity().get("c1").detail, "dev→test");
});
```

(If `test/runner-daemon.test.mjs` already imports `createDaemon`, don't duplicate the import.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/runner-daemon.test.mjs`
Expected: FAIL — `daemon.getActivity is not a function`.

- [ ] **Step 3: Wire the activity map into `createDaemon` and events into `spawnPass`**

In `skills/yarradev-run/scripts/runner/daemon.mjs`, add the import at top:

```js
import { parsePassActivity, applyEvents, pruneActivity } from "./pass-activity.mjs";
```

Replace `createDaemon` with:

```js
export function createDaemon({ runPass, intervalMs, now = () => Date.now(), activityTtlMs = 600_000, activityCap = 50 }) {
  let paused = false, inFlight = null, dirty = false, last = null;
  const activity = new Map();

  async function loop() {
    if (inFlight) { dirty = true; return inFlight; }
    inFlight = (async () => {
      do {
        dirty = false;
        try {
          const r = await runPass();
          last = { at: now(), ok: !!r?.ok, verdicts: r?.verdicts ?? 0 };
          if (Array.isArray(r?.events) && r.events.length) applyEvents(activity, r.events);
        } catch (e) { last = { at: now(), ok: false, error: String(e?.message ?? e) }; }
        pruneActivity(activity, now(), { ttlMs: activityTtlMs, cap: activityCap });
      } while (dirty && !paused);
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    requestTick() { if (!paused) return loop(); },
    pause() { paused = true; },
    resume() { paused = false; },
    isPaused: () => paused,
    passRunning: () => inFlight !== null,
    lastTick: () => last,
    getActivity: () => activity,
    async _drain() { while (inFlight) await inFlight; },
  };
}
```

In `spawnPass`, in the `child.on("close", ...)` handler, after the `verdicts` counting loop and before `resolve(...)`, add the parse and include `events` in the resolved object:

```js
      let verdicts = 0;
      for (const line of out.split("\n")) { try { const j = JSON.parse(line); if (j?.phase === "reconcile" && j.outcome === "routed") verdicts += 1; } catch {} }
      const events = parsePassActivity(out, Date.now());
      resolve({ ok: !killed && code === 0, verdicts, events, error: killed ? "pass timeout" : (code === 0 ? undefined : `exit ${code ?? signal}`) });
```

Also add `events: []` to the `child.on("error", ...)` resolve:

```js
      resolve({ ok: false, verdicts: 0, events: [], error: String(e?.message ?? e) });
```

- [ ] **Step 4: Run daemon + spawnpass tests**

Run: `node --test test/runner-daemon.test.mjs && node --test test/runner-spawnpass.test.mjs`
Expected: PASS. If a `runner-spawnpass` test deep-equals the whole resolve object, add `events: []` (error path) / `events: <parsed>` to that expectation; if it only asserts `ok`/`verdicts` individually, no change needed.

- [ ] **Step 5: Commit**

```bash
git add skills/yarradev-run/scripts/runner/daemon.mjs test/runner-daemon.test.mjs test/runner-spawnpass.test.mjs
git commit -m "feat(runner): daemon captures pass events into a live activity map"
```

---

## Task 5: Expose the board — `/board` route + provider + MCP tool

**Files:**
- Modify: `skills/yarradev-run/scripts/runner/control-plane.mjs` (add `GET /board`)
- Modify: `bin/yarradev.mjs` (`buildProvider` adds `board`)
- Modify: `skills/yarradev-run/scripts/mcp/server.mjs` (add `board` tool)
- Modify: `skills/yarradev-run/scripts/mcp/proxy.mjs` (add `board` to GET set)
- Test: `test/runner-control-plane.test.mjs`, `test/mcp-server.test.mjs`, `test/runner-cli.test.mjs`

**Interfaces:**
- Consumes: `assembleBoard` (Task 3), `daemon.getActivity()` (Task 4).
- Produces: `GET /board → row[]`; `buildProvider(...).board() → row[]`; MCP tool `board`.

- [ ] **Step 1: Write the failing control-plane test**

Append to `test/runner-control-plane.test.mjs` (follow the file's existing harness for issuing a request; if it has a helper like `request(server, method, path)`, reuse it):

```js
test("GET /board returns the assembled board rows from the provider", async () => {
  const rows = [{ cardId: "c1", role: "designer", state: "in-flight", ageS: 5, last: "dispatched" }];
  const server = createControlPlane({ provider: { board: async () => rows }, actions: {} });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/board`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), rows);
  server.close();
});
```

(Ensure `createControlPlane` is imported at the top of the file.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/runner-control-plane.test.mjs`
Expected: FAIL — `/board` returns 404.

- [ ] **Step 3: Add the `/board` route**

In `skills/yarradev-run/scripts/runner/control-plane.mjs`, after the `/cost` route line, add:

```js
      if (req.method === "GET" && p === "/board") return json(res, 200, await provider.board());
```

- [ ] **Step 4: Add `board` to the provider**

In `bin/yarradev.mjs`, add the import (extend the existing `runner/state.mjs` import):

```js
import { buildStatus, inflightRows, assembleBoard } from "../skills/yarradev-run/scripts/runner/state.mjs";
```

In `buildProvider`, add a `board` method (alongside `inflight`):

```js
    board: () => assembleBoard({ activityMap: daemon.getActivity?.() ?? new Map(), manifestContent: read(), now: Date.now(), staleS }),
```

- [ ] **Step 5: Add the MCP `board` tool + proxy GET entry**

In `skills/yarradev-run/scripts/mcp/server.mjs`, add to the `TOOLS` array (after `inflight`):

```js
  { name: "board",     description: "Live status board: cards in-flight + recently resolved/escalated (local state only).", inputSchema: S },
```

In `skills/yarradev-run/scripts/mcp/proxy.mjs`, add `"board"` to the `GET` set:

```js
const GET = new Set(["status", "inflight", "recent", "logs", "explain", "attention", "board"]);
```

- [ ] **Step 6: Update the MCP catalog + CLI GET tests**

In `test/mcp-server.test.mjs`, update the `NAMES` array to include `"board"` and bump the two length assertions from `10` to `11`:

```js
const NAMES = ["status","inflight","recent","logs","explain","attention","board","pause","resume","tick","retry"];
```
(and `assert.equal(r.result.tools.length, 11)` in the two places asserting the catalog length).

In `test/runner-cli.test.mjs`, add `"board"` to the read-route list in the `"GET set covers every read route…"` test:

```js
  for (const r of ["status", "logs", "inflight", "recent", "attention", "explain", "cost", "board"]) {
```

- [ ] **Step 7: Run the affected tests**

Run: `node --test test/runner-control-plane.test.mjs test/mcp-server.test.mjs test/runner-cli.test.mjs`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add skills/yarradev-run/scripts/runner/control-plane.mjs bin/yarradev.mjs skills/yarradev-run/scripts/mcp/server.mjs skills/yarradev-run/scripts/mcp/proxy.mjs test/runner-control-plane.test.mjs test/mcp-server.test.mjs test/runner-cli.test.mjs
git commit -m "feat(runner): expose the status board on /board + MCP board tool"
```

---

## Task 6: `renderBoard` — pure table renderer

**Files:**
- Create: `skills/yarradev-run/scripts/runner/render-board.mjs`
- Test: `test/runner-render-board.test.mjs`

**Interfaces:**
- Consumes: board `row[]` (Task 3 shape).
- Produces: `renderBoard(rows: row[], opts?: {color?: boolean}) → string`.

- [ ] **Step 1: Write the failing tests**

Create `test/runner-render-board.test.mjs`:

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/runner-render-board.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `renderBoard`**

Create `skills/yarradev-run/scripts/runner/render-board.mjs`:

```js
// skills/yarradev-run/scripts/runner/render-board.mjs — pure table renderer for the status board.
const COLORS = { "in-flight": "\x1b[36m", advanced: "\x1b[32m", ESCALATED: "\x1b[31m", retrying: "\x1b[33m" };
const RESET = "\x1b[0m";
const COLS = [
  { key: "cardId", head: "CARD" },
  { key: "role", head: "ROLE" },
  { key: "state", head: "STATE" },
  { key: "age", head: "AGE" },
  { key: "last", head: "LAST" },
];

const ageStr = (ageS) => (ageS == null ? "-" : `${ageS}s`);

/**
 * Render board rows as an aligned text table. Pure. `color:true` wraps the STATE token in ANSI.
 * @param {Array<{cardId,role,state,ageS,last}>} rows
 * @param {{color?: boolean}} [opts]
 * @returns {string}
 */
export function renderBoard(rows, { color = false } = {}) {
  if (!rows || rows.length === 0) return "(idle — nothing in flight)";
  const cells = rows.map((r) => ({ cardId: String(r.cardId), role: String(r.role ?? "-"), state: String(r.state ?? "?"), age: ageStr(r.ageS), last: String(r.last ?? "") }));
  const width = {};
  for (const c of COLS) width[c.key] = Math.max(c.head.length, ...cells.map((x) => x[c.key].length));
  const pad = (s, w) => s + " ".repeat(Math.max(0, w - s.length));
  const header = COLS.map((c) => pad(c.head, width[c.key])).join("  ").trimEnd();
  const body = cells.map((x) =>
    COLS.map((c) => {
      const padded = pad(x[c.key], width[c.key]);
      if (color && c.key === "state" && COLORS[x.state]) return COLORS[x.state] + padded + RESET;
      return padded;
    }).join("  ").trimEnd(),
  );
  return [header, ...body].join("\n");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/runner-render-board.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add skills/yarradev-run/scripts/runner/render-board.mjs test/runner-render-board.test.mjs
git commit -m "feat(runner): renderBoard pure table renderer for the status board"
```

---

## Task 7: CLI `board` (one-shot) + `watch` (live loop)

**Files:**
- Modify: `bin/yarradev.mjs`
- Test: `test/runner-cli.test.mjs`

**Interfaces:**
- Consumes: `clientUrl` (existing), `renderBoard` (Task 6), `GET /board` (Task 5).
- Produces: CLI commands `yarradev board` and `yarradev watch [--interval <ms>]`; `board` in `GET`/`COMMANDS`, `watch` in `COMMANDS`.

- [ ] **Step 1: Write the failing test for command registration**

Append to `test/runner-cli.test.mjs`:

```js
test("board is a GET command; watch is a known command (handled client-side)", () => {
  assert.ok(GET.has("board"));
  assert.ok(COMMANDS.has("board"));
  assert.ok(COMMANDS.has("watch"));
  assert.equal(clientUrl("board", 4599), "http://127.0.0.1:4599/board");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/runner-cli.test.mjs`
Expected: FAIL — `COMMANDS.has("watch")` is false.

- [ ] **Step 3: Register `board`/`watch` and add the watch loop**

In `bin/yarradev.mjs`, add the import:

```js
import { renderBoard } from "../skills/yarradev-run/scripts/runner/render-board.mjs";
```

Add `board` to the `GET` set and both commands to `COMMANDS`:

```js
export const GET = new Set(["status", "logs", "inflight", "recent", "attention", "explain", "cost", "board"]);
export const COMMANDS = new Set([...GET, "pause", "resume", "tick", "retry", "stop", "watch"]);
```

Add the watch loop (place it near `client()`):

```js
async function fetchBoard(port) {
  const res = await fetch(clientUrl("board", port), { method: "GET" });
  return res.json();
}

/** Poll /board every intervalMs, clear the screen, redraw. Tolerates a daemon blip (keeps polling). */
async function watch(port, intervalMs) {
  const color = process.stdout.isTTY;
  process.stdout.write("\x1b[?25l"); // hide cursor
  const restore = () => { process.stdout.write("\x1b[?25h"); process.exit(0); }; // show cursor on exit
  process.on("SIGINT", restore);
  process.on("SIGTERM", restore);
  for (;;) {
    let frame;
    try {
      const rows = await fetchBoard(port);
      frame = renderBoard(rows, { color }) + `\n\n  polling :${port} every ${intervalMs}ms — Ctrl-C to exit`;
    } catch (e) {
      const cause = e?.cause?.code ?? e?.message ?? e;
      frame = `runner not reachable on :${port} (${cause}) — retrying…`;
    }
    process.stdout.write("\x1b[2J\x1b[H" + frame + "\n"); // clear screen + home, then draw
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
```

Update the CLI dispatch block so `watch` is handled locally and `board` flows through `client()`. Replace the final dispatch `else` branch:

```js
  } else {
    const config = loadConfig();
    const port = config.runner?.port ?? 4599;
    if (cmd === "watch") {
      const i = process.argv.indexOf("--interval");
      const intervalMs = i !== -1 ? Number(process.argv[i + 1]) || 1000 : 1000;
      watch(port, intervalMs);
    } else {
      client(cmd, port, process.argv[3]);
    }
  }
```

Add `watch` to the `USAGE` banner text:

```
  board                      print the status board once
  watch [--interval <ms>]    live status board (default 1000ms)
```

- [ ] **Step 4: Run to verify the registration test passes**

Run: `node --test test/runner-cli.test.mjs`
Expected: PASS.

- [ ] **Step 5: Manual smoke — one-shot board + a few watch frames against the live daemon**

Run:
```bash
node bin/yarradev.mjs board
timeout 3 node bin/yarradev.mjs watch --interval 1000 | head -30
```
Expected: `board` prints the aligned table (or `(idle — nothing in flight)`); `watch` redraws it a couple of times, then the `timeout` ends it. If no daemon is running, `watch` prints the "runner not reachable — retrying…" line without crashing.

- [ ] **Step 6: Commit**

```bash
git add bin/yarradev.mjs test/runner-cli.test.mjs
git commit -m "feat(cli): yarradev board (one-shot) + watch (live status board)"
```

---

## Task 8: Docs + full-suite regression + version bump

**Files:**
- Modify: `skills/yarradev-run/SKILL.md` (document `watch`/`board` in the observability/CLI section)
- Modify: `package.json`, `.claude-plugin/plugin.json` (bump `0.16.1` → `0.17.0` — new feature → minor)

**Interfaces:** none (docs + release metadata).

- [ ] **Step 1: Document the new commands**

In `skills/yarradev-run/SKILL.md`, find the section listing the runner CLI/MCP surface (the `status`/`inflight`/`explain` list) and add:

```
- `yarradev board` — print the live status board once (cards in-flight + recently resolved/escalated).
- `yarradev watch [--interval <ms>]` — the same board, redrawn live (default 1s). Local state only; no board API calls.
```

If the MCP tool catalog is enumerated in SKILL.md, add `board` there too.

- [ ] **Step 2: Bump the version (new feature → minor)**

In both `package.json` and `.claude-plugin/plugin.json`, change `"version": "0.16.1"` to `"version": "0.17.0"`.

- [ ] **Step 3: Run the full suite**

Run: `node --test "test/*.test.mjs"`
Expected: PASS — 0 fail (2 skipped live-board tests remain skipped). Fix any assertion that still deep-equals a changed shape.

- [ ] **Step 4: Verify version coherence**

Run: `node -e "const a=require('./package.json').version,b=require('./.claude-plugin/plugin.json').version; if(a!==b||a!=='0.17.0') throw new Error(a+' vs '+b); console.log('version', a)"`
Expected: `version 0.17.0`.

- [ ] **Step 5: Commit**

```bash
git add skills/yarradev-run/SKILL.md package.json .claude-plugin/plugin.json
git commit -m "docs+release: document status board; bump v0.17.0"
```

---

## Notes for the implementer

- **Correcting the mockup:** the brainstorm mockup showed `ESCALATED / 429 transient`, but per the #65 over-parking fix a 429 is **transient and does NOT escalate**. The board therefore renders transient act-failures as `retrying` (yellow) and only deterministic parks as `ESCALATED` (red). This is intentional and matches the spec's "429 transient vs a deterministic park" wording.
- **Why the board is local-only:** the `/attention` route does an N+1 board fetch and is deliberately NOT reused here — the board must stay cheap enough to poll at 1 Hz. All data comes from the manifest + the daemon's activity map.
- **Daemon restart required to see it live:** the running daemon loaded its code before this ships; `getActivity`/`/board` only exist after a restart. (`bin/yarradev.mjs board` calling an old daemon will 404 until then — expected.)
```
