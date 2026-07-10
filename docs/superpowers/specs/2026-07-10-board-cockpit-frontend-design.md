# Board cockpit — browser frontend for the runner status board

## Problem

The `yarradev-run` daemon serves a browser page at `GET /` that is a bare 7-line
`monitor.html`: it polls `/status` every 3s and dumps the raw JSON into a `<pre>`. The
daemon now exposes a rich `GET /board` (the live status board: in-flight + recently
resolved/escalated cards) plus per-card `/explain` and `/logs`, and POST controls
(`/pause` `/resume` `/tick` `/retry`) — but there is no browser UI that uses any of it. An
operator watching the loop has only the CLI (`yarradev watch`) or raw `curl`.

## Goal

An **interactive triage cockpit** served at `GET /`: a live wallboard of what the daemon is
processing, with drill-in (per-card explain + logs) and control (pause/resume/tick, retry a
stuck card). One self-contained HTML file, rendered entirely client-side from the existing
control-plane routes.

## Scope decisions (from brainstorming)

- **Purpose:** interactive triage cockpit (not a read-only wallboard) — drill-in + controls.
- **Layout:** status/control bar on top · board fills the width · a right **slide-in** detail
  panel appears on card click · attention pinned above the board.
- **Aesthetic:** hybrid — **monospace** data grid + logs, **system-ui sans** header/controls/
  panel chrome. **Dark-only.** State colors carried from the CLI renderer.
- **Route:** replace the bare page at **`GET /`**; retire the old `/status` JSON dump. `/board`
  stays the JSON API the page renders from.
- **Attention:** the pinned strip is **local-derived** from the board's own `ESCALATED` rows
  (free, 1s-live); a separate **board-attention** view calls the expensive `/attention` N+1
  endpoint only on a **15s tick or a manual refresh** — respecting the local-is-cheap principle
  the board was built on.
- **No new server routes.** Everything the UI needs already exists.

## Architecture

Pure client-side single-page app embedded in one HTML file (`runner/monitor.html`, rewritten),
served verbatim by `control-plane.mjs` at `GET /`. Inline `<style>` + `<script>`, **no external
CSS/JS/font/network requests** (the control plane serves it as a string; a self-contained file
also means it works with no internet). Vanilla JS, no framework, no build step.

Data sources (all already served by the control plane):

| Route | Method | Used for | Poll |
|-------|--------|----------|------|
| `/board` | GET | the card grid (cardId, role, state, ageS, last) | 1s |
| `/status` | GET | header: paused/breaker/lastTick/nextTickInS/passRunning | 1s |
| `/attention` | GET | board-attention view (veto/hold/open-question/escalated) | 15s / manual |
| `/explain?card=<id>` | GET | detail panel: board+local+breaker merge | on open + manual |
| `/logs?id=<id>` | GET | detail panel: verdict/log text | on open + manual |
| `/pause` `/resume` `/tick` | POST | header controls | on click |
| `/retry?card=<id>` | POST | detail panel + attention retry | on click |

## Components

### 1. Status / control bar (top, sans chrome)
- Breaker pill: `CLOSED` (green) · `HALF_OPEN` (amber) · `OPEN` (red).
- Paused/running indicator (from `status.paused` + `status.passRunning`).
- Last tick (relative) + a **live next-tick countdown** ticking down each second from
  `status.nextTickInS` (recomputed on each `/status` poll; interpolated client-side between polls
  so it counts smoothly).
- In-flight count = the number of board rows with `state === "in-flight"` (`/status` does not
  carry this; it's derived from `/board`).
- Buttons: **Pause/Resume** (label toggles on `status.paused`) → POST `/pause`|`/resume`;
  **Tick** → POST `/tick`. After a control POST, immediately re-poll `/status` (optimistic → truth).

### 2. Attention strip (pinned above the board)
- Local-derived: the board rows whose `state === "ESCALATED"` (deterministic parks / escalate
  syncs — the genuine "needs a human" set), rendered as a compact red banner with each card id +
  `last` + a **Retry** button. `retrying` cards are NOT pinned here — they self-heal on the next
  pass, so they stay in the grid (amber) rather than the human-attention strip.
- A collapsible **"board attention"** subsection lists `/attention` rows (cardId, state,
  reasons[]) — refreshed every 15s and on a manual ↻ button; shows a "stale Ns ago" note so the
  operator knows it isn't 1s-live. Empty attention → the strip collapses to nothing.

### 3. Board table (main, monospace grid)
- Columns: CARD · ROLE · STATE · AGE · LAST. Tabular numerals; columns aligned.
- STATE color: `in-flight` cyan · `advanced` green · `retrying` amber · `ESCALATED` red ·
  `skipped`/other gray. Row background subtly tinted for ESCALATED/retrying.
- Rows are buttons: click → open the detail panel for that cardId.
- The full cardId is the key; display may middle-truncate long ids but the title/tooltip and the
  detail fetch use the full id.
- Re-rendered each `/board` poll (1s). Diff-free full re-render is fine at this scale (≤ ~60 rows);
  preserve the selected-row highlight and scroll position across re-renders.

### 4. Slide-in detail panel (right, hidden until click)
- Slides in from the right on card click; Esc or click-away (or a Close button) dismisses it.
- On open, fetches `/explain?card=<id>` and `/logs?id=<id>` in parallel. Renders:
  - **Board:** state, ci_rollup, linked_head_sha, blocked, (+ any enriched fields present).
  - **Local:** dispatch role, status, gen, verdictPath, at.
  - **Breaker:** the card's breaker view.
  - **Logs:** the verdict text in a monospace, scrollable `<pre>` (may be empty → "no verdict yet").
- **Retry** button → POST `/retry?card=<id>`, then re-fetch explain/logs; a ↻ manual refresh.
- The panel does NOT auto-poll (avoids per-card fetch storms); it refreshes on open, on Retry, and
  on manual ↻.

## Interactions & resilience

- All fetches tolerate the daemon being unreachable: on error, show a non-blocking "runner not
  reachable — retrying" banner and keep the last-rendered state; polls continue (a daemon restart
  re-connects without a page reload). Mirrors the CLI `watch` resilience.
- Controls are debounced/disabled while their POST is in flight.
- Age and countdown tick client-side each second for smoothness; the authoritative values arrive
  on the next poll.

## Aesthetic (hybrid, dark-only) — refined at build time by the frontend-design skill

- Sans (`system-ui`) for the header, controls, panel labels, buttons.
- Mono (`ui-monospace, SFMono-Regular, Menlo, monospace`) for the board grid and the logs pane.
- Dark surface with a restrained accent; state colors are the semantic palette above (carried
  from the CLI's ANSI mapping for continuity). No web fonts, no external assets.
- The build-time visual pass (frontend-design) owns spacing scale, exact palette values, the
  breaker/state pill treatment, and the slide-in motion — this spec fixes structure + behavior,
  not pixels.

## Testing

- **Server:** a `runner-control-plane` test asserting `GET /` returns `content-type: text/html`
  and a body containing a stable marker (e.g. a `data-app="yarradev-board-cockpit"` root
  attribute) — pins that the control plane serves the cockpit.
- **Any extracted pure JS helper** (e.g. relative-time / countdown formatting, state→class
  mapping) that can run under `node:test` gets a unit test. Keep such helpers small and pure.
- **UI behavior:** browser-driven verification (claude-in-chrome) against the live daemon on
  `127.0.0.1:4599` — load `/`, confirm the board renders, click a card → panel opens with
  explain+logs, exercise pause/tick, capture a screenshot. This is the real gate for a static
  HTML/JS page; note it explicitly in the plan.

## Out of scope (YAGNI)

- SSE/WebSocket push (polling at 1s is sufficient; the daemon has no board push today).
- Historical charts / trends / cost accounting (`/cost` is an unavailable stub).
- Auth / multi-user (the control plane is localhost-only, single operator).
- A build pipeline, framework, or external component library.
- Mobile-optimized layout (operator desktop tool).
