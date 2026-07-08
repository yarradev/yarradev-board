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
import { parseLastVerdict, parseErrorEnvelope, nextUnconsumedDone, reconcileVerdicts } from "../skills/yarradev-run/scripts/pass.mjs";

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
