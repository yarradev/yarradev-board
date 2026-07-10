# Cockpit: answer open questions inline

## Problem

The browser cockpit surfaces cards that need a human — the "NEEDS A HUMAN" strip (local ESCALATED
rows) and the board-attention section (`open_question`/`veto_held`/etc.) — but offers no way to
**act** on them. The most common "needs a human" case is an **open question**: a card parked by
`escalate.mjs` (an `ASK` that sets `blocked` + `open_questions[]`), which `decide()` no-ops until a
human posts an `ANSWER`. Today the only way to answer is the `answer.mjs` CLI (a terminal + the card
id + the human token). Surfacing "needs a human" without a way to respond is a half-built loop — the
cockpit already puts **Retry** inline; **Answer** is its natural sibling.

## Why the dashboard is the right place (not a governance regression)

Human-gate acts (`ANSWER`/`HUMAN_GO`/`CLEAR_VETO`) require a `human` identity so an *autonomous agent
cannot forge its own approval* — which is why the **runner MCP deliberately excludes human-gate
tools** (the MCP is the *agent* surface). The **dashboard is the *human* surface**: a person at
localhost. A human clicking "Answer" *is* the legitimate actor. The only real nuance is **token
custody**: to post `ANSWER` server-side the daemon needs a human-capable token — the same localhost
trust boundary that already governs the cockpit's `retry`/`pause`/`tick` controls, so no new
exposure for a single-operator local daemon.

Scope: **`ANSWER` only** (open questions). The higher-stakes gates — `HUMAN_GO` (staging→prod) and
`CLEAR_VETO` (security) — stay CLI-only for now (deliberate; revisit later).

## Design

### 1. Control-plane route + action (server)

- New action `answer` on the daemon control plane: `POST /answer?card=<id>&text=<url-encoded>`.
  - Reads `card` and `text` from `url.searchParams` (consistent with `retry`/`pause`/`tick`, which
    already receive `searchParams`; `encodeURIComponent` handles multiline/quotes; localhost + no
    request logging makes URL exposure moot).
  - Empty/absent `text` → default `"Resume the card."` (matches `answer.mjs`).
  - Calls `humanClient.answer(cardId, text)` → the vendored `answer()` which posts
    `{ type: "ANSWER", item_id, data: { text } }` (gen-exempt). Returns the board's `AppendResult`.
- **Token custody:** a `humanClient = makeClient({ role: "human" })` is created once in `run()` and
  passed into `buildActions({ …, humanClient })`. `resolveToken("human")` → `YDB_TOKEN_HUMAN`, falling
  back to the shared `YDB_TOKEN`. If neither can post `ANSWER`, the board returns 403 →
  `humanClient.answer` yields an `unauthorized` outcome → the action returns it verbatim (no throw).
- **Failure handling:** attempt-and-surface. On a non-committed result (403/other), the action returns
  `{ ok: false, outcome, status, reason }` (via the same `AppendResult` shape); the UI shows it inline.
- **MCP:** unchanged — `answer` is **not** added to the runner MCP catalog (agents can't answer).

### 2. `buildActions.answer` (bin/yarradev.mjs)

```
answer: async (params) => {
  const cardId = params?.get?.("card");
  const text = params?.get?.("text") || "Resume the card.";
  if (!cardId) return { ok: false, reason: "no card" };
  try {
    const r = await humanClient.answer(cardId, text);
    return { ok: r?.outcome === "committed", outcome: r?.outcome ?? null, status: r?.status ?? null,
             reason: r?.reason ?? null, cardId: String(cardId) };
  } catch (e) {
    // answer() → act() can throw on a network failure; surface it structurally, not as a bare 500.
    return { ok: false, outcome: "error", reason: String(e?.message ?? e), cardId: String(cardId) };
  }
}
```

`buildActions` gains a `humanClient` param; `run()` constructs it alongside `boardClient` and passes
both. Existing callers/tests that don't pass `humanClient` are unaffected (the field is only used by
the new action).

### 3. Cockpit UI (monitor.html)

- **Detail panel — open-question block.** When `/explain`'s `board.open_questions` is a non-empty
  array, render (above the Board section) an "Open question" block:
  - the question text + optional deadline, rendered defensively (`q.text ?? q.question ?? JSON`);
  - a `<textarea>` (placeholder "Answer / note — leave blank to just resume");
  - an **"Answer & resume"** button.
  - On submit → `POST /answer?card=<id>&text=<encoded>` → on committed, refetch `explain`+`logs` and
    `poll()`; on failure, show the result's reason inline (e.g. "couldn't answer — 403 unauthorized;
    run the daemon with `YDB_TOKEN_HUMAN`"). The button is disabled while the request is in flight.
- **Reachability.** The local "NEEDS A HUMAN" strip rows and the board-attention rows become
  **clickable → `openDetail(cardId)`**, so the flow is attention → panel (question shown) → answer.
  The strip keeps its **Retry** button; answering happens in the panel where the question text is
  visible (safer than a blind inline box). Clicking a strip/attention row's Retry button must not
  also open the panel (stop propagation on the button).

## Testing

- **Control plane:** a `POST /answer` test asserting the `answer` action is invoked with the card id
  and text from the query string (mirrors the existing `POST /pause` test).
- **Action unit:** `buildActions.answer` against a fake `humanClient` — committed → `{ ok: true }`;
  a 403/unauthorized result → `{ ok: false, outcome: "unauthorized" }`; missing card → `{ ok: false }`;
  empty text → default `"Resume the card."` forwarded.
- **UI:** browser-verified (claude-in-chrome) against a fixture whose `/explain` returns a card with
  `open_questions` — the panel shows the question + textarea; submitting posts `/answer`; a 403 fixture
  shows the inline error.

## Out of scope (YAGNI)

- `HUMAN_GO` / `CLEAR_VETO` on the dashboard (stay CLI).
- A capability/`whoami` probe to pre-hide Answer when no human token (attempt-and-surface instead).
- A request-body transport (query param is sufficient and consistent).
- Any MCP change.
