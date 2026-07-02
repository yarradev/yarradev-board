/*
 * Live mechanical-CI-gate test (no real GitHub). OPT-IN: set YDB_IT=1 and boot a stack where:
 *  - the target board (YDB_DO_NAME, default "acme:ci") has a `ci_green` gate on dev→test and the
 *    orchestrator identity (YDB_TOKEN) has CREATE/CLAIM/MOVE/LINK_PR/CLEAR_LEASE caps;
 *  - the webhook worker (YDB_WEBHOOK, default http://localhost:8803) is up with secret `local-whsec`;
 *  - CATALOG has installation '1' → repo_board(YDB_REPO default owner/repo → the board).
 * See README "Local mechanical-gate demo". Skips without YDB_IT so `npm test` stays offline-green.
 *
 * Drives the vendored orchestrator-core client (makeClient → ./vendor/core.mjs); its methods return an
 * AppendResult, so assertions read outcome/status and derive gen via genOf().
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { makeClient, genOf } from "../skills/yarradev-board-run/scripts/plugin-io.mjs";

const skip = process.env.YDB_IT === "1" ? false : "set YDB_IT=1 + boot the ci-gated board/webhook to run";
const WEBHOOK = process.env.YDB_WEBHOOK ?? "http://localhost:8803";
const WHSECRET = process.env.YDB_WHSECRET ?? "local-whsec";
const REPO = process.env.YDB_REPO ?? "owner/repo";
const INSTALL = process.env.YDB_INSTALL ?? "1";

async function deliverCheckRun(head, conclusion) {
  const body = JSON.stringify({ installation: { id: INSTALL }, repository: { full_name: REPO }, check_run: { head_sha: head, conclusion } });
  const sig = "sha256=" + createHmac("sha256", WHSECRET).update(body).digest("hex");
  const res = await fetch(WEBHOOK + "/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "check_run",
      "x-github-delivery": `it-${head}-${conclusion}`,
      "x-hub-signature-256": sig,
    },
    body,
  });
  return res.status;
}

test("mechanical gate: LINK_PR → MOVE blocked (ci_green) → green check_run ingested → advance", { skip }, async () => {
  const board = process.env.YDB_DO_NAME ?? "acme:ci";
  const client = makeClient({ doName: board, apiBase: process.env.YDB_API_BASE, token: process.env.YDB_TOKEN });
  const id = `card-ci-${Date.now()}`;
  const head = Date.now().toString(16).padEnd(40, "0").slice(0, 40); // synthetic full-length sha (board matches strings)
  const pr = Date.now() % 1000000; // unique per run → avoids LINK_PR (repo,pr_number) immutability collisions

  const created = await client.act({ type: "CREATE", item_id: id, data: { state: "dev", title: "ci-gate test" } });
  assert.equal(created.outcome, "committed", `CREATE failed: ${JSON.stringify(created)}`);

  // orchestrator's mechanical "work" branch: claim → LINK_PR → clear
  const c1 = await client.claim(id, "developer", 1800);
  assert.equal(c1.outcome, "committed", `claim failed: ${JSON.stringify(c1)}`);
  const gen1 = genOf(c1);
  const link = await client.linkPr(id, gen1, { repo: REPO, pr_number: pr, head });
  assert.equal(link.outcome, "committed", `LINK_PR failed (LINK_PR cap on board ${board}?): ${JSON.stringify(link)}`);

  // MOVE dev→test must be gate-blocked while ci_rollup is absent
  const blocked = await client.move(id, gen1, "test");
  assert.notEqual(blocked.outcome, "committed");
  assert.equal(blocked.status, 422, `expected 422 gate_blocked (ci_green); got ${blocked.status}/${blocked.outcome}`);
  await client.clearLease(id, gen1);

  // deliver a green check_run for the linked head; poll until ci_rollup flips (queue may lag locally)
  assert.equal(await deliverCheckRun(head, "success"), 200, "webhook should accept the signed delivery");
  let rollup = "absent";
  for (let i = 0; i < 24; i++) {
    const listed = await client.listCards();
    const cards = Array.isArray(listed) ? listed : (listed?.items ?? []);
    const c = cards.find((x) => x.id === id);
    rollup = c?.ci_rollup ?? "absent";
    if (rollup === "success") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(rollup, "success", `ci_rollup did not reach success (got ${rollup}) — check webhook routing/queue + repo_board seed`);

  // gate now passes: claim → MOVE dev→test commits (the "advance" branch)
  const c2 = await client.claim(id, "developer", 1800);
  assert.equal(c2.outcome, "committed", `re-claim failed: ${JSON.stringify(c2)}`);
  const gen2 = genOf(c2);
  const moved = await client.move(id, gen2, "test");
  assert.equal(moved.outcome, "committed", `MOVE dev→test should commit once CI is green: ${JSON.stringify(moved)}`);
  await client.clearLease(id, gen2);
});
