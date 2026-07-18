/*
 * pass-reconcile.test.mjs — #28. Pins the pure helpers that drive the reconcile phase of pass.mjs:
 *   - parseLastVerdict(text): last fenced ```json block → object|null (the verdict parser; SKILL.md step 2c).
 *   - nextUnconsumedDone(manifest, consumed): the set of `done` manifest entries not yet processed.
 *
 * No I/O — both helpers are pure over their string arguments (the manifest + consumed-ledger + verdict-file
 * contents), mirroring in-flight.mjs's test style. The spawn/poll/CLI shell in pass.mjs is thin and exercised
 * via the routing + dispatch tests; here we pin the reconciliation primitives.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLastVerdict, parseErrorEnvelope, nextUnconsumedDone, reconcileVerdicts, isLeaselessAdvisorRole } from "../skills/yarradev-run/scripts/pass.mjs";

// ---- parseLastVerdict -----------------------------------------------------------

test("parseLastVerdict: single fenced ```json block → object", () => {
  const text = "I reviewed the change.\n\n```json\n{\"status\":\"advance\",\"to\":\"dev\"}\n```\nDone.";
  assert.deepEqual(parseLastVerdict(text), { status: "advance", to: "dev" });
});

test("parseLastVerdict: multiple fenced json blocks → the LAST one (verdicts append reasoning)", () => {
  // A subagent may emit intermediate JSON thoughts; the verdict is the final fenced block.
  const text =
    "Thinking...\n```json\n{\"status\":\"thinking\"}\n```\nReviewed.\n```json\n{\"status\":\"advice\",\"head\":\"abc\"}\n```";
  assert.deepEqual(parseLastVerdict(text), { status: "advice", head: "abc" });
});

test("parseLastVerdict: bare fence (no `json` lang tag) → still parsed", () => {
  // The contract is "fenced block"; the `json` tag is conventional, not required.
  const text = "```\n{\"status\":\"clean\",\"head\":\"deadbeef\"}\n```";
  assert.deepEqual(parseLastVerdict(text), { status: "clean", head: "deadbeef" });
});

test("parseLastVerdict: no fenced block → null (NOT a fall back to unfenced JSON)", () => {
  // Strict by design: the verdict contract is a fenced block. Unfenced JSON is a malformed verdict → null,
  // which the reconcile loop treats as a no-parse (log; do not post).
  assert.equal(parseLastVerdict("just prose, no block"), null);
  assert.equal(parseLastVerdict("{'status':'advance'} bare"), null);
  assert.equal(parseLastVerdict(""), null);
  assert.equal(parseLastVerdict(null), null);
  assert.equal(parseLastVerdict(undefined), null);
});

test("parseLastVerdict: malformed JSON inside the fence → null (never throws)", () => {
  const text = "```json\n{not valid json\n```";
  assert.equal(parseLastVerdict(text), null);
});

test("parseLastVerdict: fenced block with surrounding whitespace / nested newlines → parsed", () => {
  const text = "```json\n\n  {\"status\":\"reject\",\"to\":\"dev\"}\n\n```";
  assert.deepEqual(parseLastVerdict(text), { status: "reject", to: "dev" });
});

test("parseLastVerdict: unclosed fence at EOF still yields the block (best-effort)", () => {
  // A truncated verdict file (subagent crashed mid-write) may lack the closing fence. Recover it rather than
  // treat it as no-verdict — the content is there. If the JSON is also truncated this still returns null via
  // the parse-fail path.
  const text = "```json\n{\"status\":\"advance\",\"to\":\"dev\"}\n";
  assert.deepEqual(parseLastVerdict(text), { status: "advance", to: "dev" });
});

test("parseLastVerdict: fence with FOUR backticks also works (markdown-tolerant)", () => {
  // ``` inside a code sample gets escaped with a 4-backtick fence; tolerate it.
  const text = "````json\n{\"status\":\"hold\"}\n````";
  assert.deepEqual(parseLastVerdict(text), { status: "hold" });
});

// ---- nextUnconsumedDone ---------------------------------------------------------

function pending(cardId, verdictPath, role = "developer", extra = {}) {
  return JSON.stringify({ status: "pending", cardId, verdictPath, role, dispatchedAt: "2026-07-07T10:00:00Z", ...extra });
}
function done(cardId, verdictPath, role = "developer", extra = {}) {
  return JSON.stringify({ status: "done", cardId, verdictPath, role, completedAt: "2026-07-07T10:05:00Z", ...extra });
}
function consumed(verdictPath) {
  return JSON.stringify({ verdictPath, consumedAt: "2026-07-07T11:00:00Z" });
}

test("nextUnconsumedDone: done+unconsumed → returned with full entry", () => {
  const manifest = done("c1", "/v/1", "designer");
  const out = nextUnconsumedDone(manifest, "");
  assert.equal(out.length, 1);
  assert.equal(out[0].cardId, "c1");
  assert.equal(out[0].verdictPath, "/v/1");
  assert.equal(out[0].role, "designer");
});

test("nextUnconsumedDone: pending (no done) → skipped (subagent still running)", () => {
  const manifest = pending("c1", "/v/1");
  assert.deepEqual(nextUnconsumedDone(manifest, ""), []);
});

test("nextUnconsumedDone: already-consumed → skipped (the dedup that prevents double-posting)", () => {
  const manifest = done("c1", "/v/1");
  const ledger = consumed("/v/1");
  assert.deepEqual(nextUnconsumedDone(manifest, ledger), []);
});

test("nextUnconsumedDone: mixed — only done+unconsumed entries come back, in manifest order", () => {
  const manifest = [
    pending("cA", "/v/a"), // pending → skip
    done("cB", "/v/b", "designer"), // done, unconsumed → keep
    done("cC", "/v/c", "developer"), // done, already consumed → skip
    done("cD", "/v/d", "tester"), // done, unconsumed → keep
  ].join("\n");
  const ledger = [consumed("/v/c")].join("\n");
  const out = nextUnconsumedDone(manifest, ledger);
  assert.deepEqual(
    out.map((e) => e.verdictPath),
    ["/v/b", "/v/d"],
    "manifest order preserved; consumed + pending filtered",
  );
});

test("nextUnconsumedDone: malformed manifest lines skipped without crashing", () => {
  // A partial/garbled append must never break reconciliation of a later, well-formed done entry.
  const manifest = ["{garbage", "", done("c1", "/v/1"), "also not json"].join("\n");
  const out = nextUnconsumedDone(manifest, "");
  assert.equal(out.length, 1);
  assert.equal(out[0].verdictPath, "/v/1");
});

test("nextUnconsumedDone: malformed consumed lines skipped without crashing", () => {
  // The consumed ledger is append-only JSONL; a corrupted line must not crash the parse nor falsely mark
  // a verdict as unconsumed (it would re-process — safe; just wasteful) nor as consumed (it would skip —
  // also safe). Here a malformed line is skipped, so a real done is still returned.
  const manifest = done("c1", "/v/1");
  const ledger = ["{bad", consumed("/v/2")].join("\n");
  const out = nextUnconsumedDone(manifest, ledger);
  assert.equal(out.length, 1);
  assert.equal(out[0].verdictPath, "/v/1");
});

test("nextUnconsumedDone: done missing cardId or verdictPath → skipped (can't route without them)", () => {
  const manifest = [
    JSON.stringify({ status: "done", verdictPath: "/v/no-card" }), // no cardId
    JSON.stringify({ status: "done", cardId: "cX" }), // no verdictPath
    done("c1", "/v/1"),
  ].join("\n");
  const out = nextUnconsumedDone(manifest, "");
  assert.equal(out.length, 1);
  assert.equal(out[0].cardId, "c1");
});

test("nextUnconsumedDone: empty / null manifest → []", () => {
  assert.deepEqual(nextUnconsumedDone("", ""), []);
  assert.deepEqual(nextUnconsumedDone(null, ""), []);
  assert.deepEqual(nextUnconsumedDone(undefined, undefined), []);
});

test("nextUnconsumedDone: empty / null consumed ledger → all done entries returned", () => {
  const manifest = [done("c1", "/v/1"), done("c2", "/v/2")].join("\n");
  assert.equal(nextUnconsumedDone(manifest, "").length, 2);
  assert.equal(nextUnconsumedDone(manifest, null).length, 2);
});

test("nextUnconsumedDone: same verdictPath in two done entries (dedup) → both returned; consume dedups", () => {
  // A pathological manifest could list the same verdictPath twice. nextUnconsumedDone returns each done line
  // independently (it doesn't dedup manifest-internal duplicates); the consumed ledger dedups across passes.
  // The FIRST processing marks it consumed, so the second is filtered next pass. This is safe (the act is
  // gen-fenced — a double-post is fenced 409), and it surfaces the manifest duplication visibly.
  const manifest = [done("c1", "/v/1"), done("c1", "/v/1")].join("\n");
  const out = nextUnconsumedDone(manifest, "");
  assert.equal(out.length, 2, "both manifest lines returned; consumed-ledger dedups across passes");
});

test("nextUnconsumedDone: preserves extra manifest fields (gen, repo, head) on returned entries", () => {
  // The dispatch-context ledger join happens in reconcileVerdicts; nextUnconsumedDone passes the parsed entry
  // through verbatim so any fields the manifest carries (role, completedAt, …) remain available.
  const manifest = done("c1", "/v/1", "developer", { head: "abc123", repo: "acme/main" });
  const out = nextUnconsumedDone(manifest, "");
  assert.equal(out[0].head, "abc123");
  assert.equal(out[0].repo, "acme/main");
});

// ---- reconcileVerdicts gen-determination (#37) -----------------------------------
// The dispatch-context ledger recorded the original CLAIM gen. If it's still current (lease active), the
// reconcile uses it directly instead of re-CLAIMing (which would 409 on the active lease and strand the card
// leased for up to claimTtlS). Re-CLAIM only when the gen is stale/absent (#27 recovery).

function manifestDoneEntry(cardId, verdictPath, role) {
  return JSON.stringify({ status: "done", cardId, verdictPath, role, completedAt: "2026-07-08T00:00:00Z" });
}

async function runReconcile({ current_gen, recorded, claimResult = { ok: true, gen: 99 }, verdictText }) {
  const calls = [];
  const results = await reconcileVerdicts({
    manifestContent: manifestDoneEntry("c1", "/v/1", "developer"),
    consumedContent: "",
    contextContent: "",
    lifecycle: {},
    machine: { transitions: [] },
    run: async (script, args) => {
      calls.push({ script, args });
      if (script === "claim.mjs") return claimResult;
      return { ok: true };
    },
    getCard: async () => ({ id: "c1", current_gen }),
    readVerdict: async () => verdictText ?? "```json\n{\"status\":\"advance\",\"to\":\"test\"}\n```",
    readContext: async () => recorded,
    appendConsumed: async () => {},
    dispatch: async () => {},
    buildAdvisorPrompt: async () => "",
    logger: () => {},
  });
  return { calls, results };
}

test("reconcile #37: lease active (originalGen === current_gen) → uses original gen, NO re-CLAIM, clears with it", async () => {
  const { calls, results } = await runReconcile({ current_gen: 7, recorded: { gen: 7, kind: "work", to: "test", role: "developer" } });
  const scripts = calls.map((c) => c.script);
  assert.ok(!scripts.includes("claim.mjs"), "must NOT re-CLAIM when the original gen is still current (the #37 bug)");
  const clear = calls.find((c) => c.script === "clear-lease.mjs");
  assert.ok(clear, "must CLEAR_LEASE");
  assert.deepEqual(clear.args, ["c1", 7], "clears with the original (still-current) gen");
  assert.equal(results[0].outcome, "routed");
});

test("reconcile #27: lease stale (originalGen !== current_gen) → re-CLAIMs fresh gen, clears with it", async () => {
  const { calls, results } = await runReconcile({ current_gen: 8, recorded: { gen: 7 }, claimResult: { ok: true, gen: 8 } });
  assert.ok(calls.find((c) => c.script === "claim.mjs"), "must re-CLAIM when the original gen is stale");
  assert.deepEqual(calls.find((c) => c.script === "clear-lease.mjs").args, ["c1", 8], "clears with the re-CLAIMed gen");
  assert.equal(results[0].outcome, "routed");
});

test("reconcile: no dispatch-context → re-CLAIMs (fallback for older dispatches / write failure)", async () => {
  const { calls } = await runReconcile({ current_gen: 7, recorded: null, claimResult: { ok: true, gen: 7 } });
  assert.ok(calls.find((c) => c.script === "claim.mjs"), "re-CLAIMs when no recorded gen is available");
});

test("reconcile: re-CLAIM 409 (card moved on) → skipped + consumed, no act posted, no CLEAR_LEASE", async () => {
  const { calls, results } = await runReconcile({ current_gen: 8, recorded: null, claimResult: { ok: false, status: 409 } });
  const scripts = calls.map((c) => c.script);
  assert.ok(!scripts.includes("move.mjs") && !scripts.includes("clear-lease.mjs"), "must not post or clear on a stale skip");
  assert.equal(results[0].outcome, "skipped");
});

// ---- reconcile #81: gen-exempt advisor verdicts must NOT re-CLAIM (clean-card livelock) ------------
// advice/clean/veto/hold are gen-exempt board acts — their routeVerdict branches post via advice/veto/
// hold.mjs using only id / verdict.head / ctx.role, never ctx.gen, and the reshape-dispatched advisor holds
// no lease of its own. Reconcile must route them WITHOUT resolving a gen. Before the fix it re-CLAIMed,
// which 409-collided with the card's ACTIVE lease (the test-stage owner) and DROPPED the verdict as "stale"
// → the clean review never landed → advisor_clear never cleared → tester+reviewer re-dispatch forever.

async function runAdvisorReconcile({ status, head = "H", reason, role = "code-reviewer", claimResult = { ok: false, status: 409 }, current_gen = 16, recorded = null, actResult = { ok: true } }) {
  const calls = [];
  const consumed = [];
  const results = await reconcileVerdicts({
    manifestContent: JSON.stringify({ status: "done", cardId: "card-sec-10", verdictPath: "/v/1", role, completedAt: "2026-07-11T10:00:00Z" }),
    consumedContent: "",
    contextContent: "",
    lifecycle: {},
    machine: { transitions: [] },
    run: async (script, args) => {
      calls.push({ script, args });
      if (script === "claim.mjs") return claimResult;
      if (script === "advice.mjs" || script === "veto.mjs" || script === "hold.mjs") return actResult;
      return { ok: true };
    },
    getCard: async () => ({ id: "card-sec-10", current_gen }),
    readVerdict: async () => "```json\n" + JSON.stringify({ status, head, ...(reason ? { reason } : {}) }) + "\n```",
    readContext: async () => recorded,
    appendConsumed: async (p) => { consumed.push(p); },
    dispatch: async () => {},
    buildAdvisorPrompt: async () => "",
    logger: () => {},
  });
  return { calls, results, consumed };
}

test("reconcile #81: clean advisor verdict + no context + lease 409 → routes advice.mjs, NO claim, NO clear-lease", async () => {
  const { calls, results } = await runAdvisorReconcile({ status: "clean" });
  const scripts = calls.map((c) => c.script);
  assert.ok(!scripts.includes("claim.mjs"), "must NOT re-CLAIM a gen-exempt advisor verdict (the #81 409-collision that drops it)");
  assert.ok(!scripts.includes("clear-lease.mjs"), "must NOT clear a lease it never held (the tester owns the active lease)");
  const advice = calls.find((c) => c.script === "advice.mjs");
  assert.ok(advice, "the clean review MUST be posted via advice.mjs (this is what clears advisor_clear)");
  assert.deepEqual(advice.args, ["card-sec-10", "H", "--role", "code-reviewer"], "advice.mjs [id, head, --role, role] — the gen-exempt contract");
  assert.equal(results[0].outcome, "routed", "must be routed, NOT skipped");
});

test("reconcile #81: veto advisor verdict is likewise gen-exempt → veto.mjs, no claim", async () => {
  const { calls, results } = await runAdvisorReconcile({ status: "veto", reason: "unsafe eval", role: "security-advisor" });
  const scripts = calls.map((c) => c.script);
  assert.ok(!scripts.includes("claim.mjs"), "veto is gen-exempt — no re-CLAIM");
  const veto = calls.find((c) => c.script === "veto.mjs");
  assert.ok(veto, "veto verdict must post via veto.mjs");
  assert.deepEqual(veto.args, ["card-sec-10", "H", "unsafe eval"], "veto.mjs [id, head, reason] — no --role, no gen");
  assert.equal(results[0].outcome, "routed");
});

// ---- reconcile #85: advisor verdict must not be lost when the advisor HELD a lease -----------------
// #81 assumed advisors are always fire-and-forget reshape-dispatched (leaseless). They are not: decide()
// returns {kind:"work", role: advisorRoleFor(st)} when advisor_clear is failing (vendor/core.mjs:183),
// which dispatchNew CLAIMs — so the advisor holds a real lease with a gen in the dispatch-context ledger.
// Routing gen-exempt then skipped CLEAR_LEASE, so the lease dangled for the full claimTtlS; decide() sees
// `leased` → noop → the card silently stalls at dev, and the advisor act's failure was never even checked.

test("reconcile #85: advisor that HELD the lease (recorded gen current) → CLEAR_LEASE at that gen, still no re-CLAIM", async () => {
  const { calls } = await runAdvisorReconcile({
    status: "advice",
    role: "security-advisor",
    recorded: { gen: 5, state: "dev", to: "test", role: "security-advisor", kind: "work" },
    current_gen: 5, // lease still ours → we hold it → we must release it
  });
  const scripts = calls.map((c) => c.script);
  assert.ok(!scripts.includes("claim.mjs"), "#81 preserved: gen-exempt verdicts never re-CLAIM");
  assert.ok(scripts.includes("advice.mjs"), "the clean review still posts");
  const clear = calls.find((c) => c.script === "clear-lease.mjs");
  assert.ok(clear, "MUST release the advisor's own lease — else it dangles for claimTtlS and decide() noops on `leased` (#85)");
  assert.deepEqual(clear.args, ["card-sec-10", 5], "clears at the gen the advisor actually holds");
});

test("reconcile #85: advisor lease already reclaimed (recorded gen stale) → no CLEAR_LEASE (not ours)", async () => {
  const { calls } = await runAdvisorReconcile({
    status: "advice",
    recorded: { gen: 5, state: "dev", to: "test", role: "code-reviewer" },
    current_gen: 9, // gen moved on — someone else holds the lease now
  });
  assert.ok(!calls.some((c) => c.script === "clear-lease.mjs"), "must never clear a lease it no longer holds (would free someone else's)");
});

test("reconcile #85: a DETERMINISTIC advisor act failure is surfaced + parked, not reported as routed", async () => {
  const { calls, results, consumed } = await runAdvisorReconcile({
    status: "advice",
    actResult: { ok: false, status: 422, outcome: "bad_act", reason: "stale head" },
  });
  assert.equal(results[0].outcome, "act_failed", "a failed ADVICE post must NOT be reported as `routed` (#85: it was, so the loss was invisible)");
  assert.ok(calls.some((c) => c.script === "escalate.mjs"), "deterministic failure never self-heals → park for a human");
  assert.deepEqual(consumed, ["/v/1"], "deterministic failure is terminal → consume (escalation carries it from here)");
});

test("reconcile #85: a TRANSIENT advisor act failure retries next pass — verdict NOT consumed, lease NOT released", async () => {
  const { calls, results, consumed } = await runAdvisorReconcile({
    status: "advice",
    recorded: { gen: 5, state: "dev", to: "test", role: "security-advisor" },
    current_gen: 5,
    actResult: { ok: false, status: 503, outcome: "error" },
  });
  assert.equal(results[0].outcome, "act_failed");
  assert.deepEqual(consumed, [], "a board blip must NOT burn the verdict — consuming it is what loses the advisor's work forever (#85)");
  assert.ok(!calls.some((c) => c.script === "escalate.mjs"), "transient → retry, don't park (#65 semantics)");
  assert.ok(!calls.some((c) => c.script === "clear-lease.mjs"), "hold the lease across the retry so decide() can't race a second advisor dispatch");
});

test("reconcile #85: veto act failure is surfaced too (binding verdicts must never be silently dropped)", async () => {
  const { results } = await runAdvisorReconcile({
    status: "veto",
    reason: "unsafe eval",
    role: "security-advisor",
    actResult: { ok: false, status: 422, outcome: "bad_act" },
  });
  assert.equal(results[0].outcome, "act_failed", "a dropped VETO would advance a card the advisor blocked");
});

// ---- parseErrorEnvelope (#44: distinguish a gateway outage from a card stall) -----------------------

test("parseErrorEnvelope: bare dispatcher error line → parsed", () => {
  const text = "API Error: 529 [overloaded]\n--- exit: 1 ---\n{\"status\":\"error\",\"error_type\":\"gateway_529\",\"detail\":\"overloaded\"}";
  assert.deepEqual(parseErrorEnvelope(text), { status: "error", error_type: "gateway_529", detail: "overloaded" });
});

test("parseErrorEnvelope: LAST envelope line wins (multiple)", () => {
  const text = "{\"status\":\"error\",\"error_type\":\"crash\",\"detail\":\"old\"}\n{\"status\":\"error\",\"error_type\":\"gateway_529\",\"detail\":\"new\"}";
  assert.equal(parseErrorEnvelope(text).error_type, "gateway_529");
});

test("parseErrorEnvelope: a real fenced verdict (no envelope) → null", () => {
  const text = "```json\n{\"status\":\"advance\",\"to\":\"test\"}\n```";
  assert.equal(parseErrorEnvelope(text), null, "a normal verdict must not be misread as an error envelope");
});

test("parseErrorEnvelope: a bare non-error JSON line → null (only status:error counts)", () => {
  const text = "some prose\n{\"status\":\"advance\",\"to\":\"test\"}";
  assert.equal(parseErrorEnvelope(text), null);
});

test("parseErrorEnvelope: empty / null → null", () => {
  assert.equal(parseErrorEnvelope(""), null);
  assert.equal(parseErrorEnvelope(null), null);
});

test("reconcile #44: a 529 verdict (no fenced block + bare envelope) → outcome dispatch_error, NOT no-parse", async () => {
  const verdictText = "API Error: 529 [1305][overloaded]\n--- attempt 4 exit: 1 ---\n{\"status\":\"error\",\"error_type\":\"gateway_529\",\"detail\":\"temporarily overloaded\"}";
  const { results } = await runReconcile({ current_gen: 7, recorded: { gen: 7 }, verdictText });
  assert.equal(results[0].outcome, "dispatch_error", "a gateway outage must surface as dispatch_error, not the generic no-parse");
  assert.equal(results[0].error_type, "gateway_529");
});

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

// ---- reconcile #87: the fallback CLAIM must never fire under an ADVISOR role -----------------------
// Follow-up to #85, same wrong premise on a different path. reconcileVerdicts takes `role` straight off
// the manifest entry; for a reshape-dispatched advisor that is the ADVISOR role. The gen-exempt guard
// only covers advice/clean/veto/hold, so any OTHER status (question, reject, advance, error, unparseable)
// fell through to the fallback CLAIM. The reshape path writes no dispatch-context entry (routeVerdict's
// advance branch calls bare dispatch()), so `recorded` is undefined → the fallback ALWAYS fired, granting
// a lease + gen bump to an advisor that was dispatched leaseless by design. The bump invalidates the stage
// owner's in-flight lease — exactly the 409 collision class #81 set out to avoid.
//
// The fix resolves the gen by READING the card instead of CLAIMing: gen-required acts fence on
// `gen === current_gen` only (workers/board/src/storage.ts) with no lease-ownership check, which is the
// same trick applySyncAction's `promote` already uses. No CLAIM → no lease, no gen bump.

const ADVISOR_LIFECYCLE = {
  dev: { owner: "developer", to: "test", advisors: [{ role: "code-reviewer" }] },
  test: { owner: "tester", to: "done" },
};

async function runReshapeAdvisorReconcile({
  status,
  role = "code-reviewer",
  current_gen = 16,
  recorded = null,
  verdictText,
  lifecycle = ADVISOR_LIFECYCLE,
}) {
  const calls = [];
  const consumed = [];
  const results = await reconcileVerdicts({
    manifestContent: JSON.stringify({ status: "done", cardId: "c1", verdictPath: "/v/1", role, completedAt: "2026-07-18T10:00:00Z" }),
    consumedContent: "",
    contextContent: "",
    lifecycle,
    machine: { transitions: [{ from: "dev", to: "spec", type: "REJECT" }] },
    run: async (script, args) => {
      calls.push({ script, args });
      if (script === "claim.mjs") return { ok: true, gen: current_gen + 1 };
      return { ok: true };
    },
    getCard: async () => ({ id: "c1", current_gen, state: "dev" }),
    readVerdict: async () => verdictText ?? "```json\n" + JSON.stringify({ status, reason: "unsure" }) + "\n```",
    readContext: async () => recorded,
    appendConsumed: async (p) => { consumed.push(p); },
    dispatch: async () => {},
    buildAdvisorPrompt: async () => "",
    logger: () => {},
  });
  return { calls, results, consumed };
}

test("reconcile #87: advisor `question` with no dispatch context → NO CLAIM, NO clear-lease, escalates", async () => {
  const { calls, consumed } = await runReshapeAdvisorReconcile({ status: "question" });
  const scripts = calls.map((c) => c.script);
  assert.ok(!scripts.includes("claim.mjs"), "must NOT CLAIM under an advisor role — the advisor is leaseless by design");
  assert.ok(!scripts.includes("clear-lease.mjs"), "must NOT clear a lease it never took");
  assert.ok(scripts.includes("escalate.mjs"), "question still parks the card (ESCALATE is gen-exempt)");
  assert.deepEqual(consumed, ["/v/1"], "the verdict is processed and consumed");
});

test("reconcile #87: advisor `reject` with no dispatch context → posts at the READ gen, no CLAIM", async () => {
  const { calls } = await runReshapeAdvisorReconcile({ status: "reject", current_gen: 16 });
  assert.ok(!calls.some((c) => c.script === "claim.mjs"), "must not CLAIM");
  const rej = calls.find((c) => c.script === "reject.mjs");
  assert.ok(rej, "advisor reject derives the backward edge and posts");
  assert.deepEqual(rej.args, ["c1", 16, "spec", "code-reviewer"], "posts at the card's CURRENT gen (read, not claimed)");
});

test("reconcile #87: advisor `error` with no dispatch context → no CLAIM, no acts, consumed", async () => {
  const { calls, consumed } = await runReshapeAdvisorReconcile({ status: "error" });
  assert.ok(!calls.some((c) => c.script === "claim.mjs"), "must not CLAIM");
  assert.ok(!calls.some((c) => c.script === "clear-lease.mjs"), "must not clear a lease it never took");
  assert.deepEqual(consumed, ["/v/1"]);
});

test("reconcile #87: unparseable advisor verdict with no dispatch context → no CLAIM, no clear-lease", async () => {
  const { calls, results } = await runReshapeAdvisorReconcile({ status: "question", verdictText: "no fenced block here" });
  assert.ok(!calls.some((c) => c.script === "claim.mjs"), "must not CLAIM to process a verdict it cannot parse");
  assert.ok(!calls.some((c) => c.script === "clear-lease.mjs"), "must not clear a lease it never took");
  assert.equal(results[0].outcome, "no-parse");
});

test("reconcile #87: an advisor that DID hold a lease (recorded context, #85) still uses it and clears it", async () => {
  // decide() dispatches an advisor as {kind:"work"} when advisor_clear is failing, and dispatchNew CLAIMs
  // that role-blind — so an advisor CAN hold a real lease, recorded in the ledger. The leaseless carve-out
  // must key off the ABSENT dispatch context, not off the role being an advisor.
  const { calls } = await runReshapeAdvisorReconcile({
    status: "question",
    recorded: { gen: 16, kind: "work", to: "test", state: "dev", role: "code-reviewer" },
  });
  const scripts = calls.map((c) => c.script);
  assert.ok(!scripts.includes("claim.mjs"), "gen still current → no re-CLAIM (#37)");
  assert.deepEqual(calls.find((c) => c.script === "clear-lease.mjs")?.args, ["c1", 16], "its own lease IS released");
});

test("reconcile #87: a WORKER with no dispatch context still re-CLAIMs (#27 recovery preserved)", async () => {
  // The carve-out must not swallow the worker recovery path: a developer whose context write failed still
  // needs a fresh gen, and its CLAIM is legitimate — it owns the stage.
  const { calls } = await runReshapeAdvisorReconcile({ status: "question", role: "developer" });
  assert.ok(calls.some((c) => c.script === "claim.mjs"), "worker recovery still re-CLAIMs");
});

test("isLeaselessAdvisorRole: advisor-only → true; owns a stage (even while advising elsewhere) → false", () => {
  const lc = {
    dev: { owner: "developer", advisors: [{ role: "code-reviewer" }, { role: "tester" }] },
    test: { owner: "tester" },
    done: { owner: "releaser", advisors: [{ role: "devops" }] },
  };
  assert.equal(isLeaselessAdvisorRole("code-reviewer", lc), true, "advises, owns nothing → leaseless");
  assert.equal(isLeaselessAdvisorRole("devops", lc), true);
  assert.equal(isLeaselessAdvisorRole("tester", lc), false, "advises dev but OWNS test → a worker; its CLAIM is legitimate");
  assert.equal(isLeaselessAdvisorRole("developer", lc), false);
  assert.equal(isLeaselessAdvisorRole("nobody", lc), false, "unknown role → never carved out (fail-closed)");
  assert.equal(isLeaselessAdvisorRole("code-reviewer", {}), false, "empty lifecycle → no carve-out");
  assert.equal(isLeaselessAdvisorRole(null, lc), false);
});

test("#94: an unroutable verdict reconciles as `unknown_status`, NOT `routed`", async () => {
  // The false-success path: no acts, no error, no actFailed → the tail's outcome mapping said "routed".
  // spawnPass tallies "routed" lines into the verdicts count, so a board doing nothing reported healthy
  // throughput. The outcome must name what happened.
  const { results, calls } = await runReconcile({
    current_gen: 7,
    recorded: { gen: 7, kind: "work", to: "test", state: "dev", role: "developer" },
    verdictText: '```json\n{"status":"aproved","to":"test"}\n```',
  });
  assert.equal(results[0].outcome, "unknown_status", "must not masquerade as routed");
  assert.equal(results[0].unknownStatus, "aproved");
  assert.ok(calls.some((c) => c.script === "escalate.mjs"), "parks for a human rather than looping");
  assert.ok(calls.some((c) => c.script === "clear-lease.mjs"), "the worker's lease is still released");
});

test("#94: a normal advance still reconciles as `routed`", async () => {
  const { results } = await runReconcile({ current_gen: 7, recorded: { gen: 7, kind: "work", to: "test", role: "developer" } });
  assert.equal(results[0].outcome, "routed");
  assert.equal("unknownStatus" in results[0], false);
});
