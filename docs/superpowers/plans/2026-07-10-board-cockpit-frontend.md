# Board Cockpit Frontend — Implementation Plan

> **For agentic workers:** This plan is executed **inline** (not subagent-driven): the deliverable is one self-contained HTML file whose behavior is verified by driving a real browser, and whose visual pass is done with the frontend-design skill — neither fits fresh-subagent-per-task. Steps use checkbox (`- [ ]`) syntax. Each task ends with a browser-driven verification checkpoint + a commit.

**Goal:** Replace the bare `monitor.html` (a 7-line `/status` JSON dump served at `GET /`) with an interactive triage cockpit: live board + status/controls + per-card slide-in detail (explain/logs) + pause/resume/tick/retry — rendered client-side from the existing control-plane routes.

**Architecture:** Pure client-side single-page app in one HTML file (`skills/yarradev-run/scripts/runner/monitor.html`), served verbatim by `control-plane.mjs` at `GET /` (already wired — the control plane reads the file at module load; **no server route change**). Inline `<style>`+`<script>`, vanilla JS, no framework, no build, no external network/font/asset. Polls `/board`+`/status` at 1s; fetches `/explain`+`/logs` on card click; POSTs `/pause`/`/resume`/`/tick`/`/retry`.

**Tech Stack:** Vanilla HTML/CSS/JS (browser). Node `node:test` only for the server-serves-it assertion. `claude-in-chrome` for UI verification. `frontend-design` skill for the visual pass.

## Global Constraints

- **Single self-contained HTML file** — inline CSS+JS; NO external CSS/JS/font/image/network requests (served as a string; must work offline). No build step, no framework, no npm deps.
- **No new server routes** — use only existing control-plane routes: GET `/board` `/status` `/attention` `/explain?card=` `/logs?id=`; POST `/pause` `/resume` `/tick` `/retry?card=`.
- **Dark-only**; hybrid aesthetic: `ui-monospace,SFMono-Regular,Menlo,monospace` for the board grid + logs, `system-ui,sans-serif` for header/controls/panel chrome.
- **State color semantics** (carried from the CLI): `in-flight`→cyan · `advanced`→green · `retrying`→amber · `ESCALATED`→red · other/`skipped`→gray.
- **Local-is-cheap:** poll `/board`+`/status` at 1s; `/attention` only at 15s or on manual refresh (it's an N+1 board call).
- **Resilience:** a fetch error shows a non-blocking "runner not reachable — retrying" banner and keeps the last render; polling continues (a daemon restart reconnects with no page reload).
- **Root marker:** the app root element carries `data-app="yarradev-board-cockpit"` (the stable test/verification marker).
- **Restart caveat:** `control-plane.mjs` caches the HTML at module load, so the running daemon needs a restart to serve the new page. Note this at hand-off; do not treat a stale served page as a bug.

---

## Task 1: Cockpit core — skeleton, poll loop, board grid, status bar, controls

**Files:**
- Modify (rewrite): `skills/yarradev-run/scripts/runner/monitor.html`
- Modify: `test/runner-control-plane.test.mjs` (strengthen the existing "GET / serves the monitor page" test to assert the cockpit marker)

**Deliverable:** a functional (visually plain) cockpit — the board renders live from `/board`, the status bar renders from `/status` with a live countdown, and pause/resume/tick work. Detail panel + attention + final visuals come in later tasks.

- [ ] **Step 1: Strengthen the serve-it test (TDD for the one server-side seam)**

In `test/runner-control-plane.test.mjs`, replace the existing `"GET / serves the monitor page"` test body so it asserts the cockpit marker and content-type:

```js
test("GET / serves the cockpit HTML with the app marker", async () => {
  const server = createControlPlane({ provider: {}, actions: {} });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const body = await res.text();
  assert.match(body, /data-app="yarradev-board-cockpit"/);
  server.close();
});
```

- [ ] **Step 2: Run it — expect FAIL (old monitor.html has no marker)**

Run: `node --test test/runner-control-plane.test.mjs`
Expected: the new assertion FAILS (`data-app` marker absent in the current 7-line page).

- [ ] **Step 3: Rewrite `monitor.html` as the cockpit core**

Replace the entire file with a self-contained page containing:
- `<!doctype html>`, `<meta charset=utf8>`, `<meta name=viewport ...>`, `<title>yarradev-run</title>`.
- Inline `<style>`: dark background; a top `header.bar` (sans); a `main` region; the board as a `<table>` (mono, `font-variant-numeric: tabular-nums`); state classes `.s-inflight`/`.s-advanced`/`.s-retrying`/`.s-escalated`/`.s-skipped` mapping to the palette colors; minimal but legible (frontend-design refines later).
- Body root: `<div id="app" data-app="yarradev-board-cockpit">` containing the header bar, an (empty for now) attention slot, a `<div id="err">` banner (hidden), and the board `<table id="board">`.
- Inline `<script>` implementing:
  - `stateClass(state)` → `"s-" + state.toLowerCase().replace(/[^a-z]/g,"")` (maps `in-flight`→`s-inflight`, `ESCALATED`→`s-escalated`, etc.). Keep it a small named function.
  - `fmtAge(ageS)` → `ageS==null ? "-" : ageS + "s"`.
  - A `poll()` that `Promise.all([fetch('/board'), fetch('/status')])`, renders the board rows and the header, and on any error shows `#err` ("runner not reachable — retrying") without clearing the last render; on success hides `#err`. `setInterval(poll, 1000)` + an immediate `poll()`.
  - Header render: breaker text + a pill class, paused/running, in-flight count = board rows with `state==="in-flight"`, and a next-tick countdown that decrements every second locally (store `nextTickInS` + a wall-clock base at each `/status` success; display `max(0, base + nextTickInS - now)`).
  - Control buttons **Pause/Resume** (label from `status.paused`) and **Tick**: on click, `fetch('/'+action, {method:'POST'})`, disable the button until it resolves, then `poll()` immediately. Resume posts `/resume`, Pause posts `/pause`.
  - Board rows are `<tr tabindex=0 data-card="<full cardId>">`; clicking sets a `selected` class (the detail-panel wire-up lands in Task 2 — for now just the selection highlight, preserved across re-renders by re-applying from a `selectedCard` variable).
- Keep the JS readable and small; no minification.

- [ ] **Step 4: Run the serve-it test — expect PASS; then full suite**

Run: `node --test test/runner-control-plane.test.mjs && node --test "test/*.test.mjs"`
Expected: PASS (marker present); full suite 0 fail (2 pre-existing skips).

- [ ] **Step 5: Browser-verify against the live daemon (the real gate)**

Using the `claude-in-chrome` skill: open a tab to `http://127.0.0.1:4599/` (restart the daemon first if it's serving the old page — see the restart caveat). Confirm: the board table renders live rows with state colors; the header shows breaker + a counting-down next-tick; clicking **Tick** triggers a pass (watch a row change / the countdown reset); **Pause** toggles to **Resume** and back. Capture a screenshot. Fix anything broken, re-verify.

- [ ] **Step 6: Commit**

```bash
git add skills/yarradev-run/scripts/runner/monitor.html test/runner-control-plane.test.mjs
git commit -m "feat(monitor): cockpit core — live board grid + status bar + controls"
```

---

## Task 2: Slide-in detail panel (explain + logs + retry)

**Files:**
- Modify: `skills/yarradev-run/scripts/runner/monitor.html`

**Deliverable:** clicking a board row opens a right slide-in panel showing the card's merged `/explain` + `/logs`, with a Retry button; Esc / click-away / Close dismisses it.

- [ ] **Step 1: Add the panel markup + styles**

Add to `#app`: an `<aside id="detail" hidden>` positioned fixed to the right, translucent-scrim behind it, transform-based slide (`transform: translateX(100%)` hidden → `0` shown; `transition: transform .18s ease`). Inside: a header (card id + Close ✕), an `#detail-explain` block (sans labels, mono values), a `#detail-logs` `<pre>` (mono, scrollable, `max-height`), and a footer with **Retry** + a ↻ **Refresh** button.

- [ ] **Step 2: Wire open/close + fetch**

In the `<script>`:
- `openDetail(cardId)`: set `selectedCard`, show `#detail` (remove `hidden`, next frame add `.open` for the transition), then `loadDetail(cardId)`.
- `loadDetail(cardId)`: `Promise.all([fetch('/explain?card='+encodeURIComponent(cardId)), fetch('/logs?id='+encodeURIComponent(cardId))])`; render explain fields (board: state/ci_rollup/linked_head_sha/blocked; local: role/status/gen/at; breaker) and the logs text (empty → "no verdict yet"); on error show a small inline "couldn't load" note inside the panel (do NOT trip the global banner).
- `closeDetail()`: remove `.open` (let it slide out), then `hidden` after the transition; clear `selectedCard`.
- Row click → `openDetail(row.dataset.card)`. `Esc` key and a click on the scrim → `closeDetail()`.
- **Retry** → `fetch('/retry?card='+encodeURIComponent(selectedCard), {method:'POST'})` then `loadDetail(selectedCard)` + `poll()`. **Refresh** → `loadDetail(selectedCard)`. The panel does NOT auto-poll.

- [ ] **Step 3: Full suite (no server change, but confirm nothing regressed)**

Run: `node --test "test/*.test.mjs"`
Expected: 0 fail.

- [ ] **Step 4: Browser-verify**

`claude-in-chrome`: reload `/`, click a card → panel slides in with explain fields + logs; click **Retry** on a stuck/ESCALATED card → panel refetches; **Close**/Esc/scrim-click dismisses. Screenshot. Fix + re-verify.

- [ ] **Step 5: Commit**

```bash
git add skills/yarradev-run/scripts/runner/monitor.html
git commit -m "feat(monitor): slide-in detail panel — explain + logs + retry"
```

---

## Task 3: Attention strip + resilience polish

**Files:**
- Modify: `skills/yarradev-run/scripts/runner/monitor.html`

**Deliverable:** a pinned attention strip (local ESCALATED rows, 1s) plus a slow board-attention section (15s/manual), and hardened error/disabled states.

- [ ] **Step 1: Attention strip (local-derived, free)**

In `poll()`'s board render, compute `escalated = rows.filter(r => r.state === "ESCALATED")`. Render an `#attention` banner above the board: red, one line per escalated card (`cardId` + `last`) with a **Retry** button (POST `/retry?card=`, then `poll()`). Empty → hide the strip. Do NOT pin `retrying` here (self-healing; stays amber in the grid).

- [ ] **Step 2: Board-attention section (slow, expensive)**

Add a collapsible `#board-attention` block with a header showing "board attention" + a ↻ button + a "updated Ns ago" note. A separate `attnPoll()` fetches `/attention` (rows: `{cardId, state, reasons[]}`), renders them (reasons as small tags: veto_held/hold_open/open_question/escalated), and stamps the last-updated time. `setInterval(attnPoll, 15000)` + the ↻ button + one call on load. Its errors are shown inline in that block (do not trip the global banner).

- [ ] **Step 3: Resilience polish**

- The global `#err` banner: show on `/board` or `/status` failure, auto-hide on the next success. Never clear the board on error (keep the last good render).
- Disable a control button while its POST is in flight; re-enable after `poll()`.
- Guard all renders against missing/partial fields (`?.` + fallbacks) so a malformed response can't blank the page.

- [ ] **Step 4: Full suite**

Run: `node --test "test/*.test.mjs"`
Expected: 0 fail.

- [ ] **Step 5: Browser-verify (including failure path)**

`claude-in-chrome`: confirm the ESCALATED strip appears for an escalated card and its Retry works; the board-attention block populates and shows the "updated Ns ago" note and ↻ works. Then stop the daemon briefly → the "runner not reachable" banner appears and the board keeps its last render; restart → it recovers with no reload. Screenshot. Fix + re-verify.

- [ ] **Step 6: Commit**

```bash
git add skills/yarradev-run/scripts/runner/monitor.html
git commit -m "feat(monitor): attention strip + board-attention (slow) + resilience"
```

---

## Task 4: Visual pass (frontend-design) + docs + version bump

**Files:**
- Modify: `skills/yarradev-run/scripts/runner/monitor.html` (visual refinement only — no behavior change)
- Modify: `skills/yarradev-run/SKILL.md` (note the browser cockpit at `http://127.0.0.1:<port>/`)
- Modify: `package.json`, `.claude-plugin/plugin.json` (0.17.0 → 0.18.0 — new feature)

**Deliverable:** the cockpit looks intentional and coherent — not a templated default — and the release metadata + docs are updated.

- [ ] **Step 1: Invoke the frontend-design skill and apply its guidance**

Load `frontend-design`. Refine `monitor.html`'s inline CSS ONLY (structure/behavior frozen): the dark palette and exact state colors (keep the semantic mapping), typographic scale + the mono/sans split, spacing rhythm, the breaker/state **pill** treatment, row hover/selected affordance, the slide-in panel's surface + motion, and the header/controls styling. Keep it a single self-contained file with no external assets. Aim for a distinctive "ops cockpit" character, not a generic dashboard.

- [ ] **Step 2: Browser-verify the visual pass**

`claude-in-chrome`: reload `/`, confirm the refined look holds across states (in-flight/advanced/retrying/ESCALATED), the panel open/close motion reads well, and nothing regressed functionally. Capture a final screenshot.

- [ ] **Step 3: Docs + version bump**

- In `SKILL.md`, in the runner section, note: the daemon serves a browser cockpit at `http://127.0.0.1:<port>/` (live board + per-card explain/logs + pause/resume/tick/retry). Additive.
- Bump `package.json` and `.claude-plugin/plugin.json` `"version": "0.17.0"` → `"version": "0.18.0"`.

- [ ] **Step 4: Full suite + version coherence**

Run: `node --test "test/*.test.mjs"` (0 fail) and
`node -e "const a=require('./package.json').version,b=require('./.claude-plugin/plugin.json').version; if(a!==b||a!=='0.18.0') throw new Error(a+' vs '+b); console.log('version', a)"` → `version 0.18.0`.

- [ ] **Step 5: Commit**

```bash
git add skills/yarradev-run/scripts/runner/monitor.html skills/yarradev-run/SKILL.md package.json .claude-plugin/plugin.json
git commit -m "feat(monitor): frontend-design visual pass; docs; bump v0.18.0"
```

---

## Notes for the implementer

- **The daemon caches `monitor.html` at module load** (`control-plane.mjs:6`), so every browser-verify step needs the daemon restarted to serve the current file. If you can't restart it, verify by opening the file directly OR by pointing a throwaway `createControlPlane` server at it — but prefer the real daemon.
- **Keep it genuinely single-file.** No `<script src>`, no `<link href>`, no web fonts, no fetched images. The only network calls are the control-plane API routes.
- **UI JS is browser-verified, not unit-tested** — that's the honest tradeoff of a self-contained inline page. The one `node:test` is the serve-it marker (Task 1). Keep any genuinely tricky pure logic minimal and obvious rather than reaching for a test harness that would force a build/module split the spec rejected.
- **Don't over-poll:** `/board`+`/status` at 1s; `/attention` at 15s/manual; the detail panel never auto-polls.
