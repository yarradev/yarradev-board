/*
 * pass-dispatch.test.mjs — #28. Pins dispatchNew: the bounded-concurrency fan-out (spec §Concurrency).
 *   - K bound: never dispatch more than pace.maxCardsPerPass cards.
 *   - Epic-bounding: dispatch from the TOP epic's ready cards first; cross-epic only if the top epic has
 *     fewer than K ready (preserves "finish one epic before the next" focus discipline).
 *   - CLAIM 409 (already leased / stale gen): skip that card, continue with the rest (best-effort).
 *
 * `run` (claim.mjs / build-prompt.mjs), `dispatch` (yarradev-dispatch), and `writeContext` (the dispatch-
 * context ledger) are injected mocks — no real board, no tmux, no gh.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchNew, selectForDispatch } from "../skills/yarradev-run/scripts/pass.mjs";

// ---- mock factories -------------------------------------------------------------

/** A card-shaped dispatch line (what list-ready emits), annotated with epicPriority for epic-bounding. */
function card(id, epicPriority, kind = "work", extra = {}) {
  return { kind, id, state: "dev", role: "developer", to: "test", title: `card ${id}`, epicPriority, ...extra };
}

/** Default injected `run`: claim committed + build-prompt returns a path. */
function defaultRun(overrides = {}) {
  return async (script, args) => {
    if (script === "claim.mjs") {
      return overrides.claim ?? { ok: true, status: 202, outcome: "committed", gen: 9 };
    }
    if (script === "build-prompt.mjs") {
      return overrides.buildPrompt ?? { ok: true, status: 200, outcome: null, path: `/tmp/prompt-${args[1]}.txt` };
    }
    return { ok: true, status: 202, outcome: "committed" };
  };
}

function defaultDeps(overrides = {}) {
  const dispatched = [];
  const contexts = [];
  return {
    dispatched,
    contexts,
    run: overrides.run ?? defaultRun(),
    dispatch: overrides.dispatch ?? ((role, cardId, promptFile) => {
      const vp = `/v/${cardId}`;
      dispatched.push({ role, cardId, promptFile, verdictPath: vp });
      return vp;
    }),
    writeContext: overrides.writeContext ?? ((verdictPath, ctx) => {
      contexts.push({ verdictPath, ctx });
    }),
    epicOf: overrides.epicOf ?? ((c) => c.epicPriority ?? 0),
    ttlS: 1800,
    now: Date.parse("2026-07-07T12:00:00Z"),
  };
}

// ---- selectForDispatch: the pure epic-bounding selector -------------------------

test("selectForDispatch: top epic has >= K → only top-epic cards (no cross-epic)", () => {
  // Top epic (priority 10) has 4 ready; K=3. Take 3 from the top epic; do NOT reach into epic 20.
  const cards = [card("a", 10), card("b", 10), card("c", 10), card("d", 10), card("e", 20), card("f", 20)];
  const sel = selectForDispatch(cards, 3, (c) => c.epicPriority);
  assert.equal(sel.length, 3);
  assert.deepEqual(sel.map((c) => c.id), ["a", "b", "c"], "all from the top epic");
});

test("selectForDispatch: top epic has < K → fill cross-epic up to K", () => {
  // Top epic (priority 10) has 2; K=4. Take 2 top + 2 from the next epic = 4.
  const cards = [card("a", 10), card("b", 10), card("c", 20), card("d", 20), card("e", 20), card("f", 30)];
  const sel = selectForDispatch(cards, 4, (c) => c.epicPriority);
  assert.equal(sel.length, 4);
  assert.deepEqual(sel.map((c) => c.id), ["a", "b", "c", "d"], "top epic first, then cross-epic fill");
});

test("selectForDispatch: K larger than total cards → dispatch all (fewer than K)", () => {
  const cards = [card("a", 10), card("b", 10)];
  const sel = selectForDispatch(cards, 5, (c) => c.epicPriority);
  assert.deepEqual(sel.map((c) => c.id), ["a", "b"]);
});

test("selectForDispatch: empty cards → []", () => {
  assert.deepEqual(selectForDispatch([], 3, (c) => c.epicPriority), []);
});

test("selectForDispatch: K=0 → [] (none dispatched)", () => {
  assert.deepEqual(selectForDispatch([card("a", 10)], 0, (c) => c.epicPriority), []);
});

test("selectForDispatch: preserves list-ready priority order (does not re-sort)", () => {
  // list-ready already sorted by (epic priority, card priority, id). selectForDispatch must take them in
  // that order verbatim — it only bounds + epic-bounds, never re-orders.
  const cards = [card("z", 10), card("y", 10), card("x", 10)];
  const sel = selectForDispatch(cards, 2, (c) => c.epicPriority);
  assert.deepEqual(sel.map((c) => c.id), ["z", "y"], "list-ready order preserved");
});

// ---- dispatchNew: the full CLAIM → build-prompt → dispatch → context chain --------

test("dispatchNew: K bound respected (5 cards, K=3 → 3 dispatched)", async () => {
  const cards = [card("a", 10), card("b", 10), card("c", 10), card("d", 10), card("e", 10)];
  const deps = defaultDeps();
  const out = await dispatchNew({ cards, K: 3, ...deps });
  assert.equal(out.dispatched.length, 3, "K caps the fan-out");
  assert.equal(out.skipped.length, 0);
  assert.deepEqual(out.dispatched.map((d) => d.cardId), ["a", "b", "c"]);
});

test("dispatchNew: epic-bounding — top epic saturated, cross-epic cards NOT dispatched", async () => {
  const cards = [card("a", 10), card("b", 10), card("c", 10), card("d", 10), card("cross", 20)];
  const deps = defaultDeps();
  const out = await dispatchNew({ cards, K: 3, ...deps });
  assert.deepEqual(
    out.dispatched.map((d) => d.cardId),
    ["a", "b", "c"],
    "cross-epic card untouched while the top epic still has ready work",
  );
});

test("dispatchNew: epic-bounding — top epic < K → cross-epic fill", async () => {
  const cards = [card("a", 10), card("b", 10), card("c", 20), card("d", 20)];
  const deps = defaultDeps();
  const out = await dispatchNew({ cards, K: 4, ...deps });
  assert.deepEqual(out.dispatched.map((d) => d.cardId), ["a", "b", "c", "d"], "top epic first, then cross-epic");
});

test("dispatchNew: full chain per card — CLAIM → build-prompt → dispatch → writeContext", async () => {
  const cards = [card("c1", 10, "work", { role: "designer", to: "dev", state: "spec" })];
  const claimCalls = [];
  const deps = defaultDeps({
    run: async (script, args) => {
      if (script === "claim.mjs") {
        claimCalls.push(args);
        return { ok: true, status: 202, outcome: "committed", gen: 7 };
      }
      if (script === "build-prompt.mjs") return { ok: true, path: `/tmp/prompt-${args[1]}.txt` };
      return { ok: true };
    },
  });
  const out = await dispatchNew({ cards, K: 1, ...deps });
  // CLAIM with role + ttl (work → no --respawn).
  assert.deepEqual(claimCalls, [["c1", "designer", 1800]], "claim.mjs <id> <role> <ttl>");
  // dispatch fired with role + cardId + the prompt path build-prompt returned.
  assert.deepEqual(out.dispatched, [
    { role: "designer", cardId: "c1", promptFile: "/tmp/prompt-c1.txt", verdictPath: "/v/c1" },
  ]);
  // context ledger recorded the dispatch context keyed by verdictPath (so reconcile can recover kind/to/state).
  assert.equal(deps.contexts.length, 1);
  assert.equal(deps.contexts[0].verdictPath, "/v/c1");
  assert.equal(deps.contexts[0].ctx.kind, "work");
  assert.equal(deps.contexts[0].ctx.to, "dev");
  assert.equal(deps.contexts[0].ctx.state, "spec");
  assert.equal(deps.contexts[0].ctx.role, "designer");
});

test("dispatchNew: kind:respawn → CLAIM carries --respawn (counts toward transition budget)", async () => {
  const cards = [card("c1", 10, "respawn", { role: "developer" })];
  const claimCalls = [];
  const deps = defaultDeps({
    run: async (script, args) => {
      if (script === "claim.mjs") { claimCalls.push(args); return { ok: true, outcome: "committed", gen: 1 }; }
      if (script === "build-prompt.mjs") return { ok: true, path: "/tmp/p.txt" };
      return { ok: true };
    },
  });
  await dispatchNew({ cards, K: 1, ...deps });
  assert.deepEqual(claimCalls, [["c1", "developer", 1800, "--respawn"]], "respawn appends --respawn to CLAIM");
});

test("dispatchNew: kind:reclaim → NO --respawn (reclaim is a lease-takeover, not a CI re-dispatch)", async () => {
  const cards = [card("c1", 10, "reclaim", { role: "developer" })];
  const claimCalls = [];
  const deps = defaultDeps({
    run: async (script, args) => {
      if (script === "claim.mjs") { claimCalls.push(args); return { ok: true, outcome: "committed", gen: 1 }; }
      if (script === "build-prompt.mjs") return { ok: true, path: "/tmp/p.txt" };
      return { ok: true };
    },
  });
  await dispatchNew({ cards, K: 1, ...deps });
  assert.deepEqual(claimCalls, [["c1", "developer", 1800]], "reclaim has no --respawn (parity with work)");
});

// ---- CLAIM 409 → skip that card, continue ---------------------------------------

test("dispatchNew: CLAIM 409 (already leased) → skip that card, dispatch the rest", async () => {
  // Card b is already leased (409). It must be skipped; a and c still dispatch.
  const cards = [card("a", 10), card("b", 10), card("c", 10)];
  const deps = defaultDeps({
    run: async (script, args) => {
      if (script === "claim.mjs") {
        if (args[0] === "b") return { ok: false, status: 409, outcome: "fenced", reason: "already leased" };
        return { ok: true, status: 202, outcome: "committed", gen: 5 };
      }
      if (script === "build-prompt.mjs") return { ok: true, path: `/tmp/p-${args[1]}.txt` };
      return { ok: true };
    },
  });
  const out = await dispatchNew({ cards, K: 3, ...deps });
  assert.deepEqual(out.dispatched.map((d) => d.cardId), ["a", "c"], "409'd card skipped, others proceed");
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].cardId, "b");
  assert.match(out.skipped[0].reason, /claim/i, "skip reason references the fence");
});

test("dispatchNew: CLAIM ok:false non-409 (e.g. transient) → also skip, do not dispatch", async () => {
  const cards = [card("a", 10)];
  const deps = defaultDeps({
    run: async (script, args) => {
      if (script === "claim.mjs") return { ok: false, status: 500, outcome: "error", reason: "board 500" };
      return { ok: true };
    },
  });
  const out = await dispatchNew({ cards, K: 1, ...deps });
  assert.equal(out.dispatched.length, 0, "no claim → no dispatch");
  assert.equal(out.skipped.length, 1);
});

test("dispatchNew: skip does not consume the K budget for that card only (b's 409 still counts as attempted)", async () => {
  // K bounds ATTEMPTED dispatches (cards we tried to claim), not successful ones — a 409'd card still
  // occupied its slot this pass (the next pass re-evaluates it; we don't immediately fall through to the
  // next card beyond K, which would unbound the fan-out). Concretely: K=2, cards [a,b,c], b 409s → dispatch
  // a + attempt b (skip) and STOP (c not reached).
  const cards = [card("a", 10), card("b", 10), card("c", 10)];
  const deps = defaultDeps({
    run: async (script, args) => {
      if (script === "claim.mjs") {
        if (args[0] === "b") return { ok: false, status: 409, outcome: "fenced" };
        return { ok: true, outcome: "committed", gen: 5 };
      }
      if (script === "build-prompt.mjs") return { ok: true, path: `/tmp/p-${args[1]}.txt` };
      return { ok: true };
    },
  });
  const out = await dispatchNew({ cards, K: 2, ...deps });
  assert.deepEqual(out.dispatched.map((d) => d.cardId), ["a"], "a dispatched");
  assert.equal(out.skipped.length, 1, "b attempted + skipped");
  // c NOT attempted — the K=2 slot covered a + b.
  assert.equal(out.dispatched.length + out.skipped.length, 2, "K bounds attempted cards, not just successful ones");
});

// ---- best-effort: one card's failure never aborts the pass ----------------------

test("dispatchNew: a thrown error in one card's dispatch is caught → logged, others proceed", async () => {
  const cards = [card("a", 10), card("b", 10), card("c", 10)];
  const deps = defaultDeps({
    dispatch: (role, cardId) => {
      if (cardId === "b") throw new Error("yarradev-dispatch vanished");
      return `/v/${cardId}`;
    },
  });
  const out = await dispatchNew({ cards, K: 3, ...deps });
  assert.deepEqual(out.dispatched.map((d) => d.cardId), ["a", "c"], "b's throw did not abort a or c");
  assert.ok(out.skipped.some((s) => s.cardId === "b" && /vanished/.test(s.reason)), "b's error surfaced as a skip reason");
});

test("dispatchNew: writeContext failure is best-effort (does not undo the dispatch)", async () => {
  const cards = [card("c1", 10)];
  const deps = defaultDeps({
    writeContext: () => { throw new Error("disk full"); },
  });
  const out = await dispatchNew({ cards, K: 1, ...deps });
  assert.equal(out.dispatched.length, 1, "the dispatch already fired; context-write failure is non-fatal");
});

test("dispatchNew: empty card list → no-op", async () => {
  const deps = defaultDeps();
  const out = await dispatchNew({ cards: [], K: 3, ...deps });
  assert.equal(out.dispatched.length, 0);
  assert.equal(out.skipped.length, 0);
});

// ---- releaser deployCmd/smokeCmd wiring (previously build-prompt was called with no extras at all,
// so the releaser always dispatched blind and escalated "no deploy command configured" regardless of
// what board.json actually had set) --------------------------------------------------------------

test("dispatchNew: releaser + configured deploy.staging → --extras-file passed with deployCmd", async () => {
  const cards = [card("c1", 10, "work", { role: "releaser", to: "staging", state: "done" })];
  const buildPromptCalls = [];
  const extrasWritten = [];
  const deps = defaultDeps({
    run: async (script, args) => {
      if (script === "build-prompt.mjs") {
        buildPromptCalls.push(args);
        return { ok: true, path: `/tmp/p-${args[1]}.txt` };
      }
      return { ok: true, outcome: "committed", gen: 5 };
    },
  });
  const out = await dispatchNew({
    cards,
    K: 1,
    ...deps,
    cfg: { deploy: { staging: "bash /Users/x/deploy-dispatch.sh staging" } },
    writeExtras: (path, content) => extrasWritten.push({ path, content }),
  });
  assert.equal(out.dispatched.length, 1, "dispatched despite the extras step");
  assert.equal(buildPromptCalls.length, 1);
  const args = buildPromptCalls[0];
  assert.ok(args.includes("--extras-file"), "build-prompt.mjs invoked with --extras-file");
  const extrasPath = args[args.indexOf("--extras-file") + 1];
  assert.equal(extrasWritten.length, 1);
  assert.equal(extrasWritten[0].path, extrasPath, "the path passed to build-prompt is the path written");
  assert.match(extrasWritten[0].content, /deployCmd: bash \/Users\/x\/deploy-dispatch\.sh staging/);
  assert.doesNotMatch(extrasWritten[0].content, /smokeCmd/, "no smoke.staging configured → no smokeCmd line");
});

test("dispatchNew: releaser + deploy.staging AND smoke.staging both configured → both lines written", async () => {
  const cards = [card("c1", 10, "work", { role: "releaser", to: "staging", state: "done" })];
  const extrasWritten = [];
  const deps = defaultDeps({
    run: async (script, args) => {
      if (script === "build-prompt.mjs") return { ok: true, path: `/tmp/p-${args[1]}.txt` };
      return { ok: true, outcome: "committed", gen: 5 };
    },
  });
  await dispatchNew({
    cards,
    K: 1,
    ...deps,
    cfg: { deploy: { staging: "deploy.sh" }, smoke: { staging: "smoke.sh" } },
    writeExtras: (path, content) => extrasWritten.push({ path, content }),
  });
  assert.match(extrasWritten[0].content, /deployCmd: deploy\.sh/);
  assert.match(extrasWritten[0].content, /smokeCmd: smoke\.sh/);
});

test("dispatchNew: releaser + NO deploy.staging configured → no --extras-file (releaser escalates on its own, as designed)", async () => {
  const cards = [card("c1", 10, "work", { role: "releaser", to: "staging", state: "done" })];
  const buildPromptCalls = [];
  const extrasWritten = [];
  const deps = defaultDeps({
    run: async (script, args) => {
      if (script === "build-prompt.mjs") {
        buildPromptCalls.push(args);
        return { ok: true, path: `/tmp/p-${args[1]}.txt` };
      }
      return { ok: true, outcome: "committed", gen: 5 };
    },
  });
  await dispatchNew({
    cards,
    K: 1,
    ...deps,
    cfg: {}, // no deploy key at all — the exact acme:main gap that stalled 1db6b7b4
    writeExtras: (path, content) => extrasWritten.push({ path, content }),
  });
  assert.ok(!buildPromptCalls[0].includes("--extras-file"), "no extras when nothing is configured");
  assert.equal(extrasWritten.length, 0);
});

test("dispatchNew: non-releaser role with deploy configured → extras NOT wired (scoped to releaser only)", async () => {
  const cards = [card("c1", 10, "work", { role: "developer", to: "dev", state: "spec" })];
  const buildPromptCalls = [];
  const deps = defaultDeps({
    run: async (script, args) => {
      if (script === "build-prompt.mjs") {
        buildPromptCalls.push(args);
        return { ok: true, path: `/tmp/p-${args[1]}.txt` };
      }
      return { ok: true, outcome: "committed", gen: 5 };
    },
  });
  await dispatchNew({
    cards,
    K: 1,
    ...deps,
    cfg: { deploy: { staging: "deploy.sh" } },
  });
  assert.ok(!buildPromptCalls[0].includes("--extras-file"), "developer dispatch is untouched by deploy config");
});

test("dispatchNew: releaser + to:prod → sources deployCmd from cfg.deploy.prod, not .staging", async () => {
  const cards = [card("c1", 10, "work", { role: "releaser", to: "prod", state: "staging" })];
  const extrasWritten = [];
  const deps = defaultDeps({
    run: async (script, args) => {
      if (script === "build-prompt.mjs") return { ok: true, path: `/tmp/p-${args[1]}.txt` };
      return { ok: true, outcome: "committed", gen: 5 };
    },
  });
  await dispatchNew({
    cards,
    K: 1,
    ...deps,
    cfg: { deploy: { staging: "wrong-leg.sh", prod: "prod-deploy.sh" }, smoke: { prod: "prod-smoke.sh" } },
    writeExtras: (path, content) => extrasWritten.push({ path, content }),
  });
  assert.match(extrasWritten[0].content, /deployCmd: prod-deploy\.sh/);
  assert.match(extrasWritten[0].content, /smokeCmd: prod-smoke\.sh/);
  assert.doesNotMatch(extrasWritten[0].content, /wrong-leg/);
});

test("dispatchNew: cfg omitted entirely (backward compat with existing callers/tests) → no crash, no extras", async () => {
  const cards = [card("c1", 10, "work", { role: "releaser", to: "staging", state: "done" })];
  const deps = defaultDeps();
  const out = await dispatchNew({ cards, K: 1, ...deps }); // no cfg passed at all
  assert.equal(out.dispatched.length, 1, "defaults cfg={} internally — does not throw");
});
