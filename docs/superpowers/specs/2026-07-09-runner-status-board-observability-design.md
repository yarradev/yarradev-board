# Runner status board — live observability of what the daemon is processing

## Problem

The `yarradev-run` daemon does substantial work each pass — dispatches cards, reconciles
landed verdicts, escalates failures — but exposes almost none of it. `spawnPass`
(`runner/daemon.mjs:31-57`) captures the pass child's full stdout (every
`{phase:"dispatch"|"reconcile"|"sync"}` JSON line) yet uses it only to **count** routed
verdicts, then discards it; stderr is drained to nothing. What survives per pass is just
`lastTick = {at, ok, verdicts:<count>}`, and `/recent` returns only that single last tick.

There is no way to see, live, **which cards the daemon is working right now, and what just
happened to each** (dispatched, advanced, escalated). Operators babysitting the loop have to
`curl` per-card `/explain` or read raw verdict files.

## Goal

A **live, card-centric status board** — `yarradev watch` — that redraws a table of the cards
the daemon is actively working (in-flight) plus those it just resolved or escalated, refreshed
~1×/second. Assembled purely from **local daemon state** (dispatch manifest + captured pass
activity) — **zero board API calls**, so it stays truly live and cheap.

Target rendering:

```
CARD          ROLE       STATE      AGE   LAST
c1-nav-shell  designer   in-flight  12s   dispatched
c2-headers    developer  in-flight  12s   dispatched
c3-auth       -          advanced   2s    dev→test
c4-cache      tester     ESCALATED  2s    429 transient
c6-login      developer  in-flight  0s    dispatched
```

## Scope decisions (from brainstorming)

- **Consumption:** a live terminal watch (not queryable history, not a browser dashboard).
- **Board scope:** active + recently-touched cards only, from local state — no `list-cards`/
  per-card board fetch (that N+1 is what makes `/attention` heavy; excluded so the 1s refresh
  stays cheap).
- **Transport:** the daemon keeps an in-memory activity map; `watch` polls a new `/board`
  route and redraws. No disk persistence, no SSE.

## Design — units (four new pure functions + one `pass.mjs` touch + wiring)

### 1. `parsePassActivity(stdout) → events[]` — pure, `runner/pass-activity.mjs` (new)

Folds a pass's emitted phase lines into per-card activity events:

```
{ cardId, role?, state?, to?, event, outcome?, detail?, at }
```

- `{phase:"dispatch", dispatched:[…], skipped:[…]}` → one `event:"dispatched"` per dispatched
  card (`state:"in-flight"`), one `event:"skipped"` per skipped card (with reason).
- `{phase:"reconcile", cardId, outcome, edge?, actFailed?}` → `event:"reconcile"` carrying the
  outcome (`routed`/`act_failed`/`skipped`/`dispatch_error`/`no-parse`/`error`), the `edge`
  (`state→to`) for a routed advance, and a `detail` (e.g. escalation reason or `429 transient`).
- `{phase:"sync", kind, id, …}` → `event:"sync"` for advance/promote/escalate.

Tolerates malformed/non-JSON lines (skips them, never throws). `at` is supplied by the caller
(the daemon stamps ingest time) so the function stays clock-free and testable.

### 2. Light enrichment of `pass.mjs` emitted lines — the one `pass.mjs` touch

The board's STATE/LAST columns need per-card detail the phase lines don't currently carry.
These values are **already computed** inside `dispatchNew`/`routeVerdict`; we only surface them:

- `dispatchNew` `dispatched[]` entries gain `to` and `state` (currently `{role, cardId,
  promptFile, verdictPath}`).
- The reconcile output line gains an `edge` (`"<state>→<to>"`) on a routed advance and, on
  `act_failed`, the failing act's `status` + a `transient` boolean (from
  `isTransientActFailure`) so the board can show e.g. `429 transient` vs a deterministic park.

Additive only — no behavioural change; existing consumers (the `verdicts` counter in
`spawnPass`, the reconcile JSON shape assertions) keep working because fields are added, not
renamed or removed.

### 3. Activity map — daemon in-memory state (`runner/pass-activity.mjs`)

Pure helpers over a `Map<cardId, event>`:

- `applyEvents(map, events)` — last-event-per-card wins; each stored event carries its ingest
  `at`.
- `pruneActivity(map, now, {ttlMs = 600_000, cap = 50})` — drop any entry whose `at` is older
  than `ttlMs` (default 10 min ≈ ~2 default pass intervals), then LRU-cap to `cap` entries
  (drop oldest `at` first) so the map can't grow unbounded. Pruning is time-based only; an
  in-flight card is always rendered from the manifest regardless of its activity entry, so a
  pruned entry only means "stop showing the *resolved* overlay," never "hide a live card."

`spawnPass` stops discarding `out`: it parses the activity (via `parsePassActivity`) and returns
`{ok, verdicts, events}`. The daemon folds `events` into its activity map and prunes, right where
it already records `lastTick`.

### 4. `assembleBoard({activityMap, manifestContent, now, staleS}) → rows[]` — pure, `runner/state.mjs`

Merges two local sources into the board rows:

- **in-flight** (from `inflightRows(manifestContent, …)`): STATE `in-flight`, LAST `dispatched`,
  ROLE from the manifest.
- **activity overlay** (from the activity map): for a card that just resolved/escalated, STATE
  becomes `advanced`/`ESCALATED`/`skipped`/…, LAST becomes the `edge` or `detail`.

`AGE` is uniformly **time since this row's last event** (`now − lastEventAt`): for an in-flight
row the last event is its dispatch (so AGE = `now − dispatchedAt`); for a resolved/escalated row
it is the reconcile/sync `at`. This keeps one consistent meaning across row kinds.

Ordering: in-flight first (oldest age first), then recently-resolved (newest first). Row shape:
`{ cardId, role, state, ageS, last }`. Served verbatim at a new `GET /board` control-plane route.

### 5. `yarradev watch` — new CLI subcommand (`bin/yarradev.mjs`)

- Polls `GET /board` every `--interval` ms (default `1000`).
- Clears the screen (ANSI) and redraws via a pure `renderBoard(rows) → string`: aligned columns
  with light colour — `ESCALATED` red, `in-flight` cyan, `advanced` green.
- Tolerates a daemon blip: on a fetch error it renders a "runner not reachable — retrying…"
  line and keeps polling (does **not** exit), so a daemon restart doesn't kill the watch.
  Ctrl-C exits cleanly (restores the cursor).
- A one-shot `yarradev board` (no loop) prints the board once and exits — the non-watching peer
  of `watch`, reusing the same `/board` route + `renderBoard`.

### 5b. `board` MCP tool + GET route (small parity add)

Add a `board` tool to the runner MCP catalog (`mcp/server.mjs`) and `/board` to the proxy/CLI
GET sets, mirroring the existing "every read route has an MCP tool" pattern. The streaming loop
stays CLI-only (MCP is request/response); the tool returns a single board snapshot.

## Data flow

```
pass.mjs (enriched phase lines on stdout)
   │  spawnPass captures stdout
   ▼
parsePassActivity(stdout) → events[]
   │  daemon: applyEvents + pruneActivity
   ▼
activityMap  ──┐
               ├─ assembleBoard(activityMap, manifestContent, now, staleS) → rows[]
manifest ──────┘            │  GET /board
                            ▼
              yarradev watch → renderBoard(rows) → redraw @ 1Hz
```

## Testing

Pure units, no board / no fs / no held connections:

- `parsePassActivity` — sample pass stdout (dispatch + reconcile-routed + act_failed→escalate +
  sync + malformed line) → expected events.
- `applyEvents` / `pruneActivity` — last-wins, TTL expiry, LRU cap.
- `assembleBoard` — in-flight only; in-flight + resolved overlay; ordering; a resolved card that
  aged past TTL dropping off.
- `renderBoard` — column alignment + the STATE tokens for each row kind (snapshot-style string
  assert).
- `spawnPass` — still returns the right `verdicts` count **and** now a populated `events` array
  from the same stdout (regression-guards the enrichment).

## Out of scope (YAGNI)

- Disk persistence / queryable history (`activity.jsonl`, `yarradev activity <card>`).
- SSE / websocket push.
- Board-API enrichment (all-non-terminal-cards view, per-card board state).
- Cost/token accounting (still an unavailable stub).
