/*
 * verdict-payload.test.mjs — GH #94, parts 1 & 2.
 *
 * A verdict can parse as JSON, carry a routable status, and still be unusable because the payload the
 * branch needs is absent: `clean`/`advice`/`veto`/`hold` need a reviewed `head`, `submitted` needs
 * evidence{repo,pr_number,head}. Nothing enforced that, and the failure mode was NOT a park — it was an
 * infinite retry:
 *
 *   advice.mjs exits 2 (usage) → makeRun wraps it as {outcome:"error"} → isTransientActFailure treats
 *   ANY outcome:"error" as a transient client crash → failActMaybePark declines to park → reconcile's
 *   transient branch leaves the verdict UNCONSUMED and holds the lease → the same malformed verdict is
 *   re-posted every pass, forever.
 *
 * Two independent fixes, either of which breaks the loop; both are here:
 *   1. validate the payload before dispatching the act (park the malformed verdict, consume it);
 *   2. stop misclassifying a usage/arg exit as transient (exit 2 is deterministic, by convention across
 *      every act script — emit() only ever exits 0/1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeVerdict, reconcileVerdicts, isTransientActFailure, makeRun } from "../skills/yarradev-run/scripts/pass.mjs";

// ---- part 2: exit-2 is deterministic, not transient ----------------------------------------------

test("#94.2: makeRun tags a usage/arg exit (status 2, no JSON) as bad_invocation", () => {
  const dir = mkdtempSync(join(tmpdir(), "yd-run-"));
  writeFileSync(join(dir, "usage.mjs"), 'process.stderr.write("usage: usage.mjs <id> <head>\\n"); process.exit(2);\n');
  const run = makeRun(dir);
  return run("usage.mjs", []).then((r) => {
    assert.equal(r.ok, false);
    assert.equal(r.status, 2);
    assert.equal(r.outcome, "bad_invocation", "a rejected invocation must be distinguishable from a crash");
    assert.match(r.reason, /usage:/);
  });
});

test("#94.2: makeRun still reports a genuine crash (non-2 exit, no JSON) as a transient error", () => {
  const dir = mkdtempSync(join(tmpdir(), "yd-run-"));
  writeFileSync(join(dir, "boom.mjs"), 'process.stderr.write("ECONNRESET\\n"); process.exit(1);\n');
  return makeRun(dir)("boom.mjs", []).then((r) => {
    assert.equal(r.outcome, "error", "a crash keeps the transient envelope — the board may just be degraded");
  });
});

test("#94.2: isTransientActFailure — bad_invocation is DETERMINISTIC (park), error stays transient", () => {
  assert.equal(isTransientActFailure({ ok: false, status: 2, outcome: "bad_invocation" }), false,
    "a script that rejected its arguments will reject them identically forever — retrying is a livelock");
  assert.equal(isTransientActFailure({ ok: false, status: null, outcome: "error" }), true,
    "a real crash/network throw stays transient");
  assert.equal(isTransientActFailure({ outcome: "gate_blocked", status: 422 }), false);
  assert.equal(isTransientActFailure({ outcome: "fenced", status: 409 }), true);
});

// ---- part 1: payload validation ------------------------------------------------------------------

const CTX = { id: "c1", state: "test", role: "code-reviewer", to: "done", gen: 4, kind: "work" };

async function route(verdict, ctx = CTX) {
  const calls = [];
  const r = await routeVerdict({
    verdict,
    ctx,
    lifecycle: {},
    machine: { transitions: [] },
    run: async (script, args) => { calls.push([script, args]); return { ok: true }; },
    dispatch: async () => {},
  });
  return { r, calls, scripts: calls.map((c) => c[0]) };
}

for (const status of ["clean", "advice"]) {
  test(`#94.1: ${status} with no head → parks as malformed, never calls advice.mjs`, async () => {
    const { r, calls, scripts } = await route({ status });
    assert.ok(r.malformedVerdict, "must report the verdict as malformed");
    assert.ok(!scripts.includes("advice.mjs"), "must not dispatch an act it knows will be rejected");
    assert.equal(scripts[0], "escalate.mjs");
    assert.match(calls[0][1][1], /head/, "the park must name the missing field");
    assert.match(calls[0][1][1], /code-reviewer@test/, "…and where it came from");
  });
}

for (const status of ["veto", "hold"]) {
  test(`#94.1: ${status} with no head → parks as malformed, never calls ${status}.mjs`, async () => {
    const { r, scripts } = await route({ status, reason: "looks risky" });
    assert.ok(r.malformedVerdict);
    assert.ok(!scripts.includes(`${status}.mjs`));
    assert.equal(scripts[0], "escalate.mjs");
  });
}

test("#94.1: submitted with incomplete evidence → parks as malformed, never calls link-pr.mjs", async () => {
  const { r, calls, scripts } = await route(
    { status: "submitted", evidence: { repo: "acme/main", head: "abc" } }, // pr_number missing
    { ...CTX, state: "dev", role: "developer", to: "test" },
  );
  assert.ok(r.malformedVerdict);
  assert.ok(!scripts.includes("link-pr.mjs") && !scripts.includes("push.mjs"));
  assert.match(calls[0][1][1], /evidence/);
});

test("#94.1: a clean verdict WITHOUT `role` is still valid — the plugin sources role from ctx", async () => {
  // core's parseVerdict requires `role` on advice/clean/veto/hold, but routeVerdict deliberately uses
  // ctx.role (THIS pass's dispatched advisor) and ignores verdict.role. Requiring it here would reject
  // valid verdicts — another instance of the #94 contract drift, pinned so nobody "aligns" it by mistake.
  const { r, scripts } = await route({ status: "clean", head: "abc123" });
  assert.equal(r.malformedVerdict, undefined);
  assert.ok(scripts.includes("advice.mjs"));
});

test("#94.1: valid payloads are untouched (advice with head, submitted with full evidence)", async () => {
  const a = await route({ status: "advice", head: "h1", reason: "ok" });
  assert.equal(a.r.malformedVerdict, undefined);
  assert.ok(a.scripts.includes("advice.mjs"));

  const s = await route(
    { status: "submitted", evidence: { repo: "acme/main", pr_number: 42, head: "h" } },
    { ...CTX, state: "dev", role: "developer", to: "test" },
  );
  assert.equal(s.r.malformedVerdict, undefined);
  assert.ok(s.scripts.includes("link-pr.mjs"));
});

// ---- the loop this closes ------------------------------------------------------------------------

test("#94: a malformed gen-exempt verdict is CONSUMED and parked — not retried forever", async () => {
  const consumed = [];
  const calls = [];
  const results = await reconcileVerdicts({
    manifestContent: JSON.stringify({ status: "done", cardId: "c1", verdictPath: "/v/1", role: "code-reviewer" }),
    consumedContent: "",
    contextContent: "",
    lifecycle: {},
    machine: { transitions: [] },
    run: async (script) => { calls.push(script); return { ok: true }; },
    getCard: async () => ({ id: "c1", current_gen: 5, state: "test" }),
    readVerdict: async () => '```json\n{"status":"clean"}\n```', // no head
    readContext: async () => ({ gen: 5, state: "test", role: "code-reviewer" }),
    appendConsumed: async (p) => consumed.push(p),
    dispatch: async () => {},
    buildAdvisorPrompt: async () => "",
    logger: () => {},
  });
  assert.equal(results[0].outcome, "malformed_verdict");
  assert.notEqual(results[0].retry, true, "must NOT ask for a retry — that was the infinite loop");
  assert.deepEqual(consumed, ["/v/1"], "the verdict must be consumed so it cannot be re-posted next pass");
  assert.ok(calls.includes("escalate.mjs"), "parks for a human");
  assert.ok(calls.includes("clear-lease.mjs"), "releases the advisor's lease rather than holding it");
});
