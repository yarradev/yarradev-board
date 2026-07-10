# Cockpit — Answer Open Questions Implementation Plan

> **For agentic workers:** executed **inline** (browser-verified UI, like the cockpit itself). Steps use `- [ ]`. Two tasks; each ends in a verification checkpoint + commit.

**Goal:** Let a human answer a card's open question directly from the browser cockpit — a `POST /answer` control-plane action (human identity) + an answer block in the detail panel — closing the "needs a human" loop that today only Retry serves.

**Architecture:** New `answer` action in `buildActions` (posts `ANSWER` under a `humanClient = makeClient({role:"human"})`); the control plane already dispatches POST actions generically, so **no `control-plane.mjs` change**. The cockpit's detail panel renders an open-question block (question + textarea + "Answer & resume") when `/explain`'s card has `open_questions`; attention rows become clickable to reach it. Not added to the MCP (agents can't answer).

**Tech Stack:** Vanilla Node (`node:test`) + the existing control plane; vanilla HTML/JS for the panel; `claude-in-chrome` for UI verification.

## Global Constraints

- **`ANSWER` only** — `HUMAN_GO`/`CLEAR_VETO` stay CLI. **No MCP change** (agents can't answer).
- **Token custody:** the daemon posts `ANSWER` under `makeClient({role:"human"})` (`YDB_TOKEN_HUMAN`, fallback shared `YDB_TOKEN`). **Attempt-and-surface:** a 403/other non-committed result is returned structurally and shown inline; never a crash.
- **Query-param transport:** `POST /answer?card=<id>&text=<url-encoded>` (consistent with `retry`/`pause`; the control plane passes `url.searchParams` to actions). Empty `text` → `"Resume the card."`.
- **Self-contained UI:** inline only; no external assets. Clicking a row's Retry must not also open the panel (stop propagation).
- Test one file: `node --test --test-timeout=15000 test/<file>.test.mjs` (the harness auto-backgrounds `node --test`; run with an explicit timeout and read the result file). Full suite: `node --test "test/*.test.mjs"`.

---

## Task 1: `POST /answer` action + human client (server)

**Files:**
- Modify: `bin/yarradev.mjs` (`buildActions` gains `humanClient` + an `answer` action; `run()` builds `humanClient`)
- Test: `test/runner-cli.test.mjs` (answer action unit), `test/runner-control-plane.test.mjs` (POST /answer query-param wiring)

**Interfaces:**
- Produces: `buildActions({ daemon, client, humanClient, stopSources, getServer })` with an `answer(searchParams) → { ok, outcome, status, reason, cardId }` async action. `humanClient` must expose `answer(cardId, text) → AppendResult`.

- [ ] **Step 1: Write the failing action unit test**

Append to `test/runner-cli.test.mjs`:

```js
test("buildActions.answer posts ANSWER under the human client; committed → ok, empty text → default", async () => {
  const calls = [];
  const humanClient = { async answer(id, text) { calls.push([id, text]); return { outcome: "committed", status: 202 }; } };
  const actions = buildActions({ daemon: { requestTick() {} }, humanClient });
  const r = await actions.answer(new URLSearchParams({ card: "c1" })); // no text → default
  assert.deepEqual(r, { ok: true, outcome: "committed", status: 202, reason: null, cardId: "c1" });
  assert.deepEqual(calls, [["c1", "Resume the card."]]);
});

test("buildActions.answer surfaces a rejected ANSWER (no human token → 403) as ok:false, and refuses a missing card", async () => {
  const humanClient = { async answer() { return { outcome: "unauthorized", status: 403, reason: "delegate scope does not permit ANSWER" }; } };
  const actions = buildActions({ daemon: { requestTick() {} }, humanClient });
  const r = await actions.answer(new URLSearchParams({ card: "c1", text: "go" }));
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "unauthorized");
  assert.deepEqual(await actions.answer(new URLSearchParams({})), { ok: false, reason: "no card" });
});
```

- [ ] **Step 2: Run — expect FAIL (answer action undefined)**

Run: `node --test --test-timeout=15000 test/runner-cli.test.mjs > "$TMPDIR/t.txt" 2>&1; grep -c "answer" "$TMPDIR/t.txt"; grep -E "^ℹ (tests|pass|fail)" "$TMPDIR/t.txt"`
Expected: FAIL — `actions.answer is not a function`.

- [ ] **Step 3: Add `humanClient` + the `answer` action**

In `bin/yarradev.mjs`, change the `buildActions` signature and add the action:

```js
export function buildActions({ daemon, client, humanClient, stopSources, getServer }) {
  return {
    pause: () => { daemon.pause(); return { ok: true, paused: true }; },
    resume: () => { daemon.resume(); return { ok: true, paused: false }; },
    tick: () => { daemon.requestTick(); return { ok: true }; },
    retry: (params) => retryCard(params?.get?.("card"), { client, requestTick: () => daemon.requestTick() }),
    // Human-gate act: answer a card's open question (ANSWER, gen-exempt) under the human identity.
    // Attempt-and-surface — a rejected act (no human token → 403) returns ok:false, never throws a 500.
    answer: async (params) => {
      const cardId = params?.get?.("card");
      const text = params?.get?.("text") || "Resume the card.";
      if (!cardId) return { ok: false, reason: "no card" };
      try {
        const r = await humanClient.answer(cardId, text);
        return { ok: r?.outcome === "committed", outcome: r?.outcome ?? null, status: r?.status ?? null, reason: r?.reason ?? null, cardId: String(cardId) };
      } catch (e) {
        return { ok: false, outcome: "error", reason: String(e?.message ?? e), cardId: String(cardId) };
      }
    },
    // pause() FIRST: without it, an in-flight loop with dirty=true (a tick already queued while
    // the current pass runs) fires one more coalesced runPass after stop() has torn down sources.
    stop: () => { daemon.pause(); stopSources?.(); getServer?.()?.close(); return { ok: true, stopped: true }; },
  };
}
```

In `run()`, build the human client next to `boardClient` and pass it in. Find:

```js
  const boardClient = makeClient({ role: "orchestrator" });
```

Add after it:

```js
  // Human identity for human-gate acts posted from the dashboard (ANSWER). resolveToken("human") →
  // YDB_TOKEN_HUMAN, falling back to the shared YDB_TOKEN; a 403 is surfaced by the action, not fatal.
  const humanClient = makeClient({ role: "human" });
```

And update the `buildActions(...)` call in `run()` to pass `humanClient`:

```js
  const actions = buildActions({ daemon, client: boardClient, humanClient, stopSources, getServer: () => server });
```

- [ ] **Step 4: Run the action unit — expect PASS**

Run: `node --test --test-timeout=15000 test/runner-cli.test.mjs > "$TMPDIR/t.txt" 2>&1; grep -E "^ℹ (tests|pass|fail)" "$TMPDIR/t.txt"`
Expected: 0 fail.

- [ ] **Step 5: Add the control-plane query-param wiring test**

Append to `test/runner-control-plane.test.mjs`:

```js
test("POST /answer invokes the answer action with card + text from the query string", async () => {
  let got = null;
  const server = createControlPlane({ provider: {}, actions: { answer: (p) => { got = { card: p.get("card"), text: p.get("text") }; return { ok: true }; } } });
  const port = await listen(server);
  const r = await fetch(`http://127.0.0.1:${port}/answer?card=c1&text=${encodeURIComponent("looks good, resume")}`, { method: "POST" });
  assert.equal(r.status, 200);
  assert.deepEqual(got, { card: "c1", text: "looks good, resume" });
  server.close();
});
```

- [ ] **Step 6: Run control-plane + full suite**

Run: `node --test --test-timeout=15000 test/runner-control-plane.test.mjs test/runner-cli.test.mjs > "$TMPDIR/t.txt" 2>&1; grep -E "^ℹ (tests|pass|fail)" "$TMPDIR/t.txt"` then the full suite `node --test "test/*.test.mjs" > "$TMPDIR/f.txt" 2>&1; grep -E "^ℹ (tests|pass|fail|skipped)" "$TMPDIR/f.txt"`.
Expected: 0 fail (2 pre-existing skips).

- [ ] **Step 7: Commit**

```bash
git add bin/yarradev.mjs test/runner-cli.test.mjs test/runner-control-plane.test.mjs
git commit -m "feat(runner): POST /answer control-plane action (human identity, attempt-and-surface)"
```

---

## Task 2: Cockpit answer UI + reachability + docs + v0.19.0

**Files:**
- Modify: `skills/yarradev-run/scripts/runner/monitor.html`
- Modify: `skills/yarradev-run/SKILL.md`, `package.json`, `.claude-plugin/plugin.json`

**Interfaces:** consumes `POST /answer?card=&text=` (Task 1) and `/explain`'s `board.open_questions`.

- [ ] **Step 1: Render the open-question block in the detail panel**

In `monitor.html`, in `renderDetail(ex, logs)`, before the `"<h3>Board</h3>"` line, insert an open-question block when present:

```js
    var oq = ex.board && Array.isArray(ex.board.open_questions) ? ex.board.open_questions : [];
    if (oq.length) {
      html += "<h3>Open question · needs a human</h3><div class=\"oq\">";
      for (var qi = 0; qi < oq.length; qi++) {
        var q = oq[qi] || {};
        var qtext = q.text != null ? q.text : (q.question != null ? q.question : JSON.stringify(q));
        var dl = q.deadline_ts != null ? ' <span class="note">· deadline ' + esc(String(q.deadline_ts)) + "</span>" : "";
        html += '<div class="oq-q">' + esc(qtext) + dl + "</div>";
      }
      html += '<textarea id="oq-text" placeholder="Answer / note — leave blank to just resume"></textarea>'
        + '<div class="oq-act"><button id="oq-submit">Answer &amp; resume</button><span id="oq-msg" class="note"></span></div>'
        + "</div>";
    }
```

Add CSS (near the `#detail` rules): a `.oq` block with a left amber spine, a readable question, and a full-width textarea:

```css
  #detail .oq { border: 1px solid color-mix(in srgb, var(--amber) 40%, transparent); border-radius: 5px;
                background: color-mix(in srgb, var(--amber) 7%, transparent); box-shadow: inset 3px 0 0 var(--amber);
                padding: .6rem .7rem; margin-bottom: 1rem; }
  #detail .oq-q { font-family: var(--mono); font-size: 12px; color: var(--fg); margin-bottom: .5rem; white-space: pre-wrap; }
  #detail .oq textarea { width: 100%; min-height: 4.5rem; resize: vertical; background: var(--bg); color: var(--fg);
                border: 1px solid var(--line); border-radius: 5px; font-family: var(--mono); font-size: 12px; padding: .5rem; }
  #detail .oq-act { display: flex; align-items: center; gap: .6rem; margin-top: .5rem; }
```

Also move the `#detail h3` selector so the open-question `<h3>` gets the eyebrow style — it already matches `#detail h3` (no change needed).

- [ ] **Step 2: Wire the answer submit (event delegation on the panel body)**

Add near the other detail-panel handlers in `monitor.html`:

```js
  document.getElementById("d-body").addEventListener("click", async function (ev) {
    if (!ev.target || ev.target.id !== "oq-submit" || !selectedCard) return;
    var btn = ev.target, msg = document.getElementById("oq-msg");
    var ta = document.getElementById("oq-text");
    var text = ta && ta.value.trim() ? ta.value.trim() : "Resume the card.";
    btn.disabled = true; msg.textContent = "answering…";
    try {
      var r = await fetch("/answer?card=" + encodeURIComponent(selectedCard) + "&text=" + encodeURIComponent(text), { method: "POST" });
      var out = await r.json();
      if (out && out.ok) { msg.textContent = "answered — card will resume next pass"; await loadDetail(selectedCard); await poll(); }
      else { btn.disabled = false; msg.textContent = "couldn't answer — " + esc((out && (out.reason || out.outcome)) || ("HTTP " + r.status)) + (out && out.outcome === "unauthorized" ? " (run the daemon with YDB_TOKEN_HUMAN)" : ""); }
    } catch (e) { btn.disabled = false; msg.textContent = "couldn't answer — " + esc(e.message); }
  });
```

- [ ] **Step 3: Make attention rows clickable → open the panel**

In `renderAttention`, give each strip row a `data-card` and make it open the detail; keep Retry from also opening it. Change the strip row markup to add `data-card` on the row `<div>` and update the strip click handler:

```js
  document.getElementById("attention").addEventListener("click", async function (ev) {
    var rb = ev.target.closest("button[data-retry]");
    if (rb) { ev.stopPropagation(); rb.disabled = true; await retryCard(rb.getAttribute("data-retry")); await poll(); return; }
    var row = ev.target.closest("[data-card]");
    if (row) openDetail(row.getAttribute("data-card"));
  });
```

Update the strip row template in `renderAttention` to put `data-card="..."` on the `.row` div (wrap the existing content), and add `style="cursor:pointer"` (or a `.row{cursor:pointer}` rule). Do the same for `.ba-row` in `attnPoll` (add `data-card` + a delegated click on `#ba-body` → `openDetail`). Add:

```js
  document.getElementById("ba-body").addEventListener("click", function (ev) {
    var row = ev.target.closest("[data-card]"); if (row) openDetail(row.getAttribute("data-card"));
  });
```
and add `data-card="' + esc(r.cardId) + '"` (+ a pointer cursor) to the `.ba-row` template.

- [ ] **Step 4: Browser-verify against a fixture with an open question**

Restart the fixture server with an `/explain` that returns a card carrying `open_questions` (e.g. `[{ text: "Spec section 3 is ambiguous — which behavior?", deadline_ts: null }]`), and an `/answer` that returns `{ ok: true }` (and a second fixture returning `{ ok:false, outcome:"unauthorized", status:403 }` to check the error path). Using `claude-in-chrome`: click an ESCALATED/attention card → the panel shows the open-question block + textarea; type an answer → Answer & resume → posts `/answer`, message updates; verify the 403 fixture shows the inline "run the daemon with YDB_TOKEN_HUMAN" message. Screenshot. Fix + re-verify.

- [ ] **Step 5: Docs + version bump**

- In `SKILL.md`'s browser-cockpit line (Observability section), add: "…and **answer a card's open question** inline (posts `ANSWER` under the human identity)."
- Bump `package.json` + `.claude-plugin/plugin.json` `"version": "0.18.0"` → `"version": "0.19.0"`.

- [ ] **Step 6: Full suite + version coherence**

Run: `node --test "test/*.test.mjs" > "$TMPDIR/f.txt" 2>&1; grep -E "^ℹ (tests|pass|fail|skipped)" "$TMPDIR/f.txt"` (0 fail) and
`node -e "const a=require('./package.json').version,b=require('./.claude-plugin/plugin.json').version; if(a!==b||a!=='0.19.0') throw new Error(a+' vs '+b); console.log('version', a)"` → `version 0.19.0`.

- [ ] **Step 7: Commit**

```bash
git add skills/yarradev-run/scripts/runner/monitor.html skills/yarradev-run/SKILL.md package.json .claude-plugin/plugin.json
git commit -m "feat(monitor): answer open questions inline (detail panel) + clickable attention rows; v0.19.0"
```

---

## Notes for the implementer

- **No `control-plane.mjs` change** — POST actions dispatch generically via `actions[name](searchParams)`; adding the `answer` action to `buildActions` is enough.
- **Daemon restart caveat** (unchanged): the running daemon caches `monitor.html` at load and predates this route — verify via the throwaway fixture/proxy, not the live daemon.
- **`open_questions` field name** is rendered defensively (`q.text ?? q.question ?? JSON`) since the exact key isn't pinned in the plugin repo.
- The answer button lives in the re-rendered panel body, so it's wired by **delegation** on the stable `#d-body`, not a direct listener.
