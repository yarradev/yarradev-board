/*
 * raise-bugs-from-review.test.mjs — Phase B / B3.5 (auto-raised-bug-cards §6). Pins the standalone
 * review-bridge: findings -> spawn[] mapping (CONFIRMED-only, malformed-drop), PR-or-card resolution
 * (B2), and the single ADVICE-act post — with a fake client/resolvePrLink (no network), mirroring the
 * other CLI scripts' unit-test harness (note.test.mjs, release.test.mjs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSpawn,
  resolveCardId,
  runRaiseBugsFromReview,
  REVIEW_INTAKE_CARD_ID,
} from "../skills/yarradev-run/scripts/raise-bugs-from-review.mjs";

// ── buildSpawn: findings -> spawn[] ──────────────────────────────────────────────────────────────

test("buildSpawn: maps well-formed findings, stamping the default repo when a finding omits its own", () => {
  const findings = [
    { title: "Off-by-one", file: "src/x.ts", summary: "off by one", note: "repro" },
    { title: "Null deref", file: "src/y.ts", summary: "null deref", repo: "other/repo" },
  ];
  const { spawn, dropped } = buildSpawn(findings, "o/r");
  assert.equal(dropped, 0);
  assert.deepEqual(spawn, [
    { title: "Off-by-one", file: "src/x.ts", summary: "off by one", repo: "o/r", note: "repro" },
    { title: "Null deref", file: "src/y.ts", summary: "null deref", repo: "other/repo" },
  ]);
});

test("buildSpawn: keeps a finding with no status field (assumed already-filtered per contract)", () => {
  const { spawn, dropped } = buildSpawn([{ title: "t", file: "f", summary: "s" }], "o/r");
  assert.equal(dropped, 0);
  assert.equal(spawn.length, 1);
});

test("buildSpawn: drops a finding whose status is explicitly not CONFIRMED (defense in depth)", () => {
  const findings = [
    { title: "confirmed one", file: "a.ts", summary: "a", status: "CONFIRMED" },
    { title: "unlikely", file: "b.ts", summary: "b", status: "UNLIKELY" },
    { title: "suspected", file: "c.ts", summary: "c", status: "suspected" },
  ];
  const { spawn, dropped } = buildSpawn(findings, "o/r");
  assert.equal(dropped, 2);
  assert.deepEqual(spawn.map((s) => s.title), ["confirmed one"]);
});

test("buildSpawn: drops malformed entries (missing title/file/summary) without throwing", () => {
  const findings = [
    { title: "good", file: "a.ts", summary: "valid", repo: "o/r" },
    { title: "", file: "b.ts", summary: "missing title", repo: "o/r" },
    { title: "no file", summary: "missing file", repo: "o/r" },
    { file: "d.ts", summary: "missing title field", repo: "o/r" },
  ];
  const { spawn, dropped } = buildSpawn(findings, "o/r");
  assert.equal(dropped, 3);
  assert.deepEqual(spawn, [{ title: "good", file: "a.ts", summary: "valid", repo: "o/r" }]);
});

test("buildSpawn: with no default repo, a finding must carry its own repo or it is dropped", () => {
  const findings = [
    { title: "has own repo", file: "a.ts", summary: "a", repo: "o/r" },
    { title: "no repo anywhere", file: "b.ts", summary: "b" },
  ];
  const { spawn, dropped } = buildSpawn(findings, undefined);
  assert.equal(dropped, 1);
  assert.deepEqual(spawn, [{ title: "has own repo", file: "a.ts", summary: "a", repo: "o/r" }]);
});

// ── resolveCardId: literal id vs PR-number resolution (B2) ──────────────────────────────────────

test("resolveCardId: a non-numeric argument is a literal card id — resolvePrLink is never called", async () => {
  let called = false;
  const id = await resolveCardId("card-abc123", "o/r", async () => {
    called = true;
    return "should-not-be-used";
  });
  assert.equal(id, "card-abc123");
  assert.equal(called, false);
});

test("resolveCardId: a bare or #-prefixed PR number resolves via resolvePrLink (hit)", async () => {
  const resolvePrLink = async (repo, prNumber) => {
    assert.equal(repo, "o/r");
    assert.equal(prNumber, 42);
    return "card-1";
  };
  assert.equal(await resolveCardId("42", "o/r", resolvePrLink), "card-1");
  assert.equal(await resolveCardId("#42", "o/r", resolvePrLink), "card-1");
});

test("resolveCardId: a PR number with no pr_link match falls back to review-intake (miss)", async () => {
  const id = await resolveCardId("999", "o/r", async () => null);
  assert.equal(id, REVIEW_INTAKE_CARD_ID);
});

test("resolveCardId: a PR number with no --repo throws a usage error (B2 needs repo to resolve)", async () => {
  await assert.rejects(() => resolveCardId("42", undefined, async () => "x"), /--repo/);
});

// ── runRaiseBugsFromReview: the end-to-end orchestration (fake client, no network) ──────────────

function fakeClient(actResult) {
  const acts = [];
  return {
    acts,
    async act(a) {
      acts.push(a);
      return actResult;
    },
  };
}

test("runRaiseBugsFromReview: posts exactly ONE ADVICE act carrying reviewed_head/reason/spawn", async () => {
  const client = fakeClient({ outcome: "committed", status: 202, applied: true });
  const resolvePrLink = async () => "card-1";
  const out = await runRaiseBugsFromReview(client, resolvePrLink, {
    cardIdOrPr: "42",
    repo: "o/r",
    head: "h1",
    findings: [{ title: "Bug A", file: "a.ts", summary: "bug a", note: "repro a" }],
  });

  assert.equal(client.acts.length, 1, "the bridge posts exactly one act — never CREATE, never more than one ADVICE");
  assert.deepEqual(client.acts[0], {
    type: "ADVICE",
    item_id: "card-1",
    data: {
      reviewed_head: "h1",
      reason: "1 CONFIRMED finding(s)",
      spawn: [{ title: "Bug A", file: "a.ts", summary: "bug a", repo: "o/r", note: "repro a" }],
    },
  });
  assert.equal(out.cardId, "card-1");
  assert.equal(out.spawnCount, 1);
  assert.equal(out.dropped, 0);
  assert.equal(out.result.outcome, "committed");
});

test("runRaiseBugsFromReview: an explicit --reason overrides the generated default", async () => {
  const client = fakeClient({ outcome: "committed", status: 202, applied: true });
  await runRaiseBugsFromReview(client, async () => "card-1", {
    cardIdOrPr: "card-1",
    repo: "o/r",
    reason: "custom reason",
    findings: [{ title: "Bug A", file: "a.ts", summary: "bug a" }],
  });
  assert.equal(client.acts[0].data.reason, "custom reason");
});

test("runRaiseBugsFromReview: a null head defaults reviewed_head to null (board tolerates it)", async () => {
  const client = fakeClient({ outcome: "committed", status: 202, applied: true });
  await runRaiseBugsFromReview(client, async () => "card-1", {
    cardIdOrPr: "card-1",
    repo: "o/r",
    findings: [{ title: "Bug A", file: "a.ts", summary: "bug a" }],
  });
  assert.equal(client.acts[0].data.reviewed_head, null);
});

test("runRaiseBugsFromReview: dropped findings are counted but never block the ADVICE post", async () => {
  const client = fakeClient({ outcome: "committed", status: 202, applied: true });
  const out = await runRaiseBugsFromReview(client, async () => "card-1", {
    cardIdOrPr: "card-1",
    repo: "o/r",
    findings: [
      { title: "Good", file: "a.ts", summary: "valid" },
      { title: "", file: "b.ts", summary: "missing title" },
      { title: "Not confirmed", file: "c.ts", summary: "x", status: "SUSPECTED" },
    ],
  });
  assert.equal(out.dropped, 2);
  assert.equal(out.spawnCount, 1);
  assert.equal(client.acts[0].data.spawn.length, 1);
});
