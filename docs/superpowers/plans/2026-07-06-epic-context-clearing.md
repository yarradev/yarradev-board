# Epic-scoped context clearing + card priority — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add card-level priority with epic-scoped ordering, and enable the conductor to
clear conversation context at epic boundaries (and on context-pressure) via signal-file
exit + external wrapper restart.

**Architecture:** Three small, independent changes: `create.mjs` gains a `--priority` flag;
`list-ready.mjs` sorts cards by (root-epic priority, card priority, id) before routing;
SKILL.md instructs the conductor to detect epic completion, write a signal file, check a
prep-clear flag, and call `/exit`. The external wrapper (`yarradev-loop`) and statusline
CTX% publishing are user infrastructure — not part of this plan.

**Tech Stack:** Plain Node.js (no deps), node:http stubs for tests, vendored orchestrator-core.

## Global Constraints

- Plugin works standalone without `yarradev-loop` wrapper — exits cleanly, user restarts manually.
- Priority defaults: epic = 50, story/bug = 100 (lower = higher priority).
- `list-ready.mjs` must still emit the same JSON line shape — existing conductor parsing unchanged.
- No board-side changes required — `priority` is a `data` blob field, passed through by the board.
- Pass-count fallback hardcoded at 40 (not configurable in v1).
- Files touched: `create.mjs`, `list-ready.mjs`, `SKILL.md`, `create-cli.test.mjs`, new `list-ready-priority.test.mjs`.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `skills/yarradev-run/scripts/create.mjs` | Modify | Parse `--priority`, add to card data |
| `skills/yarradev-run/scripts/list-ready.mjs` | Modify | Collect enriched cards, sort by priority, then route |
| `skills/yarradev-run/SKILL.md` | Modify | Priority discipline, prep-clear check, epic-done signal, pass-count fallback |
| `test/create-cli.test.mjs` | Modify | Test `--priority` flag behaviour |
| `test/list-ready-priority.test.mjs` | Create | Test priority sort order end-to-end |

---

### Task 1: `create.mjs` — `--priority` flag

**Files:**
- Modify: `skills/yarradev-run/scripts/create.mjs:28-84`
- Modify: `test/create-cli.test.mjs` (append tests)

**Interfaces:**
- Consumes: existing `parseArgs()`, `makeClient()`, `emit()` from `plugin-io.mjs`
- Produces: `--priority <n>` flag parsed into `data.priority` (integer), default 100 for story/bug, 50 for epic

- [ ] **Step 1: Add `--priority` to the usage string**

In `create.mjs:3`, update the header comment to include `[--priority <n>]`:

```js
 * create.mjs <title...> [--id <id>] [--type story|epic] [--state <s>] [--parent <id>] [--priority <n>] [--lane fast|full] [--role <r>]
```

In `create.mjs:65-66`, update the `console.error` usage line:

```js
"usage: create.mjs <title...> [--id <id>] [--type story|epic] [--state <s>] [--parent <id>] [--priority <n>] [--lane fast|full] [--role <r>]",
```

- [ ] **Step 2: Parse `--priority` in `parseArgs()`**

In `create.mjs:32`, add `priority: undefined` to the opts object:

```js
const opts = { id: undefined, type: undefined, state: undefined, parent: undefined, priority: undefined, lane: undefined, role: "analyst" };
```

In `create.mjs:33-57`, add the `--priority` case inside the switch:

```js
case "--priority":
  opts.priority = parseInt(argv[++i], 10);
  if (isNaN(opts.priority)) {
    console.error(`usage: --priority must be an integer, got '${argv[i]}'`);
    process.exit(2);
  }
  break;
```

Place it after the `--parent` case (line 46-47) and before `--lane`:

```js
case "--parent":
  opts.parent = argv[++i];
  break;
case "--priority":
  opts.priority = parseInt(argv[++i], 10);
  if (isNaN(opts.priority)) {
    console.error(`usage: --priority must be an integer, got '${argv[i]}'`);
    process.exit(2);
  }
  break;
case "--lane":
```

- [ ] **Step 3: Set `data.priority` with type-aware default**

In `create.mjs:78`, replace the `data` construction. Currently:

```js
const data = { type: opts.type ?? "story", title: opts.title };
```

Replace with:

```js
const resolvedType = opts.type ?? "story";
const defaultPriority = resolvedType === "epic" ? 50 : 100;
const data = { type: resolvedType, title: opts.title, priority: opts.priority ?? defaultPriority };
```

The full block (lines 77-80) becomes:

```js
const id = opts.id ?? crypto.randomUUID();
const resolvedType = opts.type ?? "story";
const defaultPriority = resolvedType === "epic" ? 50 : 100;
const data = { type: resolvedType, title: opts.title, priority: opts.priority ?? defaultPriority };
if (state) data.state = state;
if (opts.parent) data.parent_id = opts.parent;
```

- [ ] **Step 4: Write failing test — `--priority` is posted in card data**

Append to `test/create-cli.test.mjs`:

```js
test("create.mjs --priority is posted in card data", async () => {
  const { server, requests } = startStub();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  await run(["High-priority task", "--priority", "1"], {
    YDB_API_BASE: `http://127.0.0.1:${port}`,
    YDB_DO_NAME: "create-cli-test",
    YDB_TOKEN: "test.token",
  });
  await new Promise((r) => server.close(r));

  assert.equal(requests[0].body.data.priority, 1);
});
```

- [ ] **Step 5: Write failing test — epic defaults to priority 50**

```js
test("create.mjs --type epic defaults to priority 50", async () => {
  const { server, requests } = startStub();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  await run(["SSO migration", "--type", "epic"], {
    YDB_API_BASE: `http://127.0.0.1:${port}`,
    YDB_DO_NAME: "create-cli-test",
    YDB_TOKEN: "test.token",
  });
  await new Promise((r) => server.close(r));

  assert.equal(requests[0].body.data.priority, 50);
  assert.equal(requests[0].body.data.type, "epic");
});
```

- [ ] **Step 6: Write failing test — story defaults to priority 100**

```js
test("create.mjs --type story defaults to priority 100", async () => {
  const { server, requests } = startStub();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  await run(["Regular task"], {
    YDB_API_BASE: `http://127.0.0.1:${port}`,
    YDB_DO_NAME: "create-cli-test",
    YDB_TOKEN: "test.token",
  });
  await new Promise((r) => server.close(r));

  assert.equal(requests[0].body.data.priority, 100);
});
```

- [ ] **Step 7: Write failing test — `--priority` non-integer exits 2**

```js
test("create.mjs --priority with non-integer exits 2", async () => {
  const { server, requests } = startStub();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  const { code, stderr } = await run(["Bad priority", "--priority", "high"], {
    YDB_API_BASE: `http://127.0.0.1:${port}`,
    YDB_DO_NAME: "create-cli-test",
    YDB_TOKEN: "test.token",
  });
  await new Promise((r) => server.close(r));

  assert.equal(code, 2);
  assert.match(stderr, /priority/);
  assert.equal(requests.length, 0, "must not hit the network on a usage error");
});
```

- [ ] **Step 8: Run tests — expect 4 failures (missing --priority support)**

Run: `node --test test/create-cli.test.mjs`
Expected: 4 new tests FAIL — `data.priority` not present, defaults not applied, validation missing.

- [ ] **Step 9: Implement steps 1-3 (production code)**

Apply the three edits from steps 1-3 above.

- [ ] **Step 10: Run tests — all pass**

Run: `node --test test/create-cli.test.mjs`
Expected: all tests PASS (8 tests — 4 existing + 4 new).

- [ ] **Step 11: Commit**

```bash
git add skills/yarradev-run/scripts/create.mjs test/create-cli.test.mjs
git commit -m "feat(create): add --priority flag with type-aware defaults

Epics default to priority 50, stories/bugs to 100. Non-integer
--priority values exit 2 (usage error).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: `list-ready.mjs` — priority sort

**Files:**
- Modify: `skills/yarradev-run/scripts/list-ready.mjs:48-81`
- Create: `test/list-ready-priority.test.mjs`

**Interfaces:**
- Consumes: `listCards()`, `getEnriched()`, `decide()`, `getMachine()`, `assertLifecycleCoherent()` from vendored core; `makeClient()`, `loadConfig()` from `plugin-io.mjs`
- Produces: same JSON line shape per actionable card (`{ kind, id, state, title, role?, to?, reason? }`), but lines are now emitted in priority order

- [ ] **Step 1: Write the sort helper function**

In `list-ready.mjs`, after the imports (line 25), add a helper that resolves a card's root epic priority:

```js
/**
 * Resolve the priority of the root epic for a card. If the card IS an epic, its own
 * priority is the group key. If it has a parent, walk up via enriched cache until
 * we find an epic or hit a card with no parent. Standalone cards use their own priority.
 *
 * @param {object} card — enriched card with { id, type, parent_id?, priority? }
 * @param {Map<string, object>} enriched — id → enriched card (all fetched cards)
 * @returns {number} root epic priority, or the card's own priority if standalone
 */
function epicPriorityOf(card, enriched) {
  if (card.type === "epic") return card.priority ?? 50;
  let cursor = card;
  while (cursor && cursor.parent_id) {
    const parent = enriched.get(cursor.parent_id);
    if (!parent) break;
    if (parent.type === "epic") return parent.priority ?? 50;
    cursor = parent;
  }
  // Standalone or unresolvable parent chain — use own priority
  return card.priority ?? 100;
}
```

- [ ] **Step 2: Restructure the main loop to collect → sort → emit**

Currently `list-ready.mjs:53-81` iterates `items` one at a time: fetch enriched, decide, emit. Replace with a collect-then-sort pattern.

Replace lines 53-81:

```js
for (const summary of items) {
  // ... skip corrupt, fetch enriched, decide, emit ...
}
```

With:

```js
// Phase 1: collect all enriched cards
const enriched = new Map();
for (const summary of items) {
  if (!summary.id) {
    process.stderr.write(`skip <empty-id> (${summary.state}): corrupt item — unactionable\n`);
    continue;
  }
  const card = await client.getEnriched(summary.id);
  if (!card) {
    process.stderr.write(`skip ${summary.id} (${summary.state}): enriched fetch returned nothing (see any [boardClient] HTTP-status line above)\n`);
    continue;
  }
  enriched.set(card.id, card);
}

// Phase 2: resolve root epic priorities and sort
// Sort key: (root_epic_priority, card_priority, card_id)
const sorted = [...enriched.values()].sort((a, b) => {
  const epA = epicPriorityOf(a, enriched);
  const epB = epicPriorityOf(b, enriched);
  if (epA !== epB) return epA - epB;
  const pA = a.priority ?? 100;
  const pB = b.priority ?? 100;
  if (pA !== pB) return pA - pB;
  return (a.id ?? "").localeCompare(b.id ?? "");
});

// Phase 3: route each card through decide() in priority order
for (const card of sorted) {
  const a = decide(card, cfg.lifecycle, policy, now);
  if (a.kind === "noop") {
    process.stderr.write(`skip ${card.id} (${card.state}): ${a.reason}\n`);
    continue;
  }
  const line = { kind: a.kind, id: card.id, state: card.state, title: card.title };
  if (a.role) line.role = a.role;
  if (a.to) line.to = a.to;
  if (a.reason) line.reason = a.reason;
  process.stdout.write(JSON.stringify(line) + "\n");
}
```

- [ ] **Step 3: Write test file — `test/list-ready-priority.test.mjs`**

Create the test file with a stub server that returns cards in mixed order and asserts the output is priority-sorted:

```js
/*
 * list-ready-priority.test.mjs — hermetic test for priority sort in list-ready.mjs.
 * Stubs the board API to return cards with different priorities and types, then
 * asserts stdout lines are in (epic_priority, card_priority, id) order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIST_READY = join(HERE, "..", "skills", "yarradev-run", "scripts", "list-ready.mjs");

function run(env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LIST_READY], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("list-ready emits cards in (epic priority, card priority, id) order", async () => {
  // Stub: GET /config returns a machine coherent with the default lifecycle
  const lifecycle = {
    backlog: { owner: "designer", to: "spec" },
    spec: { owner: "designer", to: "dev" },
    dev: { owner: "developer", to: "test", gate: "mechanical" },
    test: { owner: "tester", to: "done" },
    done: { owner: "releaser", to: "staging", gate: "judgement" },
    staging: { owner: "", to: "prod", gate: "human" },
    prod: { owner: "", to: null },
    epic_analysis: { owner: "analyst", to: "epic_decompose", gate: "judgement" },
    epic_decompose: { owner: "analyst", to: "epic_integrating", gate: "judgement" },
    epic_integrating: { owner: "", to: "epic_done", gate: "barrier", promoteAs: "analyst" },
    epic_done: { owner: "", to: null },
  };

  // Build a coherent machine from the lifecycle (mirrors assertLifecycleCoherent's check)
  const transitions = [];
  for (const [state, cfg] of Object.entries(lifecycle)) {
    if (cfg.to) {
      transitions.push({ from: state, to: cfg.to, type: "MOVE" });
    }
  }
  const machine = { transitions, terminal: ["prod", "epic_done"] };

  // Cards: epics should be picked in priority order, stories within epics by own priority
  // Epic "Audit" (p: 20) has story "Export" (p: 1) — should come FIRST
  // Epic "SSO" (p: 10) has stories "OAuth" (p: 2) and "JWT" (p: 1) — SSO epic is higher pri
  // Standalone story "Refactor" (p: 50) has no parent
  const cards = [
    { id: "story-jwt",     state: "dev", title: "JWT refresh",  type: "story", parent_id: "epic-sso",   priority: 2 },
    { id: "story-refactor", state: "spec", title: "Refactor DB", type: "story", priority: 50 },
    { id: "epic-audit",    state: "epic_analysis", title: "Audit Log", type: "epic", priority: 20 },
    { id: "epic-sso",      state: "epic_analysis", title: "SSO",       type: "epic", priority: 10 },
    { id: "story-oauth",   state: "dev", title: "OAuth flow",  type: "story", parent_id: "epic-sso",   priority: 2 },
    { id: "story-export",  state: "dev", title: "Export CSV",  type: "story", parent_id: "epic-audit", priority: 1 },
  ];

  // Expected order:
  // 1. epic-sso (priority 10) — highest epic priority, epic itself
  // 2. story-oauth (epic-sso, priority 2, id < story-jwt)
  // 3. story-jwt   (epic-sso, priority 2, id > story-oauth)
  // 4. epic-audit  (priority 20) — second epic
  // 5. story-export (epic-audit, priority 1)
  // 6. story-refactor (standalone, priority 50)

  let listCallCount = 0;
  const enrichedCalls = [];

  const server = createServer((req, res) => {
    if (req.url === "/boards/test-priority/config" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(machine));
      return;
    }
    if (req.url === "/boards/test-priority/cards" && req.method === "GET") {
      listCallCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: cards }));
      return;
    }
    // Enriched card fetch: /boards/test-priority/cards/<id>/enriched
    const match = req.url?.match(/\/boards\/test-priority\/cards\/(.+)\/enriched/);
    if (match && req.method === "GET") {
      const id = match[1];
      enrichedCalls.push(id);
      const card = cards.find((c) => c.id === id);
      if (!card) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      // Enriched view includes parent_id and priority
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ...card,
        current_gen: 1,
        open_questions: [],
        vetoes: [],
        next_transitions: [{ from: card.state, to: lifecycle[card.state]?.to, type: "MOVE" }],
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  const { code, stdout } = await run({
    YDB_API_BASE: `http://127.0.0.1:${port}`,
    YDB_DO_NAME: "test-priority",
    YDB_TOKEN: "test.token",
  });
  await new Promise((r) => server.close(r));

  assert.equal(code, 0, `expected exit 0, got ${code}; stderr not captured but check manually`);

  const lines = stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ids = lines.map((l) => l.id);

  assert.deepEqual(ids, [
    "epic-sso",
    "story-oauth",
    "story-jwt",
    "epic-audit",
    "story-export",
    "story-refactor",
  ], "cards must be in (epic priority, card priority, id) order");
});
```

- [ ] **Step 4: Run the test — expect failure (no sort logic yet)**

Run: `node --test test/list-ready-priority.test.mjs`
Expected: FAIL — cards are emitted in listCards() order, not priority-sorted.

- [ ] **Step 5: Apply steps 1-2 (production code)**

Apply the sort helper and the collect→sort→emit restructure from steps 1-2 above.

- [ ] **Step 6: Run tests — all pass**

Run: `node --test test/list-ready-priority.test.mjs`
Expected: PASS

Run full suite: `npm test`
Expected: all existing tests still pass (priority sort doesn't change the output shape, only the order).

- [ ] **Step 7: Commit**

```bash
git add skills/yarradev-run/scripts/list-ready.mjs test/list-ready-priority.test.mjs
git commit -m "feat(list-ready): sort cards by (epic priority, card priority, id)

Cards are grouped by root epic priority, then ordered by their own
priority within the epic, with id as tiebreaker. Standalone cards
use their own priority.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: SKILL.md — conductor contract update

**Files:**
- Modify: `skills/yarradev-run/SKILL.md`

**Interfaces:**
- Consumes: none (documentation-only change)
- Produces: conductor follows new priority discipline, checks prep-clear flag, writes epic-done signal, increments pass counter

- [ ] **Step 1: Add priority discipline rule**

In the `## Discipline & safety` section (after the "one subagent per card per pass" rule), add:

```markdown
- **Process epics in priority order; finish one before starting the next.** `list-ready.mjs` emits
  cards sorted by (epic priority, card priority, id). Process the first actionable card in that
  order. Do not pick up a story from a different epic while the current epic has ready work.
- **Plugin bugs are not your job to fix.** (existing — unchanged)
```

- [ ] **Step 2: Add prep-clear check at the top of per-pass procedure**

In the `## Per-pass procedure` section, after the intro line (line 83: `Let S=...`), add a step 0:

```markdown
0. **Check context-pressure flag.** If `/tmp/yarradev-prep-clear` exists, do NOT claim a new
   card this pass. If a card is currently in-flight (leased), finish it normally — post its act
   and CLEAR_LEASE. Then write a partial `/tmp/yarradev-epic-done` (see epic completion below)
   and call `/exit`. If no card is in-flight, write the signal and exit immediately.
```

- [ ] **Step 3: Add epic completion sequence to the promote branch**

In the promote branch (step 2, `promote` kind, after the existing sub-steps), add:

```markdown
   **Epic completion.** If this promote was for an epic card (`type === "epic"`) and the
   transition was `epic_integrating → epic_done` (the barrier gate cleared), the epic and all
   its children are terminal. After CLEAR_LEASE:
   1. Gather summary: epic id, title, `children_total`, current time.
   2. Write `/tmp/yarradev-epic-done`:
      `{"epicId":"<id>","title":"<title>","completedAt":"<ISO8601>","storyCount":<children_total>,"bugCount":0}`
   3. Call `/exit`. The wrapper restarts the session with clean context.
   
   If this was NOT an epic barrier (e.g. human GO `staging→prod`), do NOT write the signal —
   the loop continues normally.
```

- [ ] **Step 4: Add pass-count fallback to the yield step**

In the yield step (step 3, line 370), after "Yield.", add:

```markdown
   Also increment the epic pass counter:
   ```
   COUNT=$(cat /tmp/yarradev-epic-pass-count 2>/dev/null || echo 0)
   echo $((COUNT + 1)) > /tmp/yarradev-epic-pass-count
   ```
   If `$COUNT` reaches 40 (≈3.3h at 5-min intervals), the same pass writes
   `/tmp/yarradev-prep-clear` itself (the next pass's step 0 catches it).
   This is the safety valve when no statusline CTX% integration is available.
```

- [ ] **Step 5: Document the signal file in the config section**

In `## Config & auth`, after the existing notes, add a short section documenting the exit contract:

```markdown
- **Epic-boundary context clearing.** When an epic reaches `epic_done`, the conductor writes
  `/tmp/yarradev-epic-done` (JSON: epic id, title, completedAt, storyCount) and calls `/exit`.
  An optional external wrapper (`~/work/tools/yarradev-loop`) watches this file and restarts
  the session with clean context. Without the wrapper, the conductor exits cleanly — restart
  manually. A context-pressure flag (`/tmp/yarradev-prep-clear`) triggers the same exit
  sequence mid-epic when the context window is filling up.
```

- [ ] **Step 6: Commit**

```bash
git add skills/yarradev-run/SKILL.md
git commit -m "docs(skill): epic-boundary context clearing + priority discipline

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: End-to-end integration check

**Files:**
- No new files. Run full test suite and confirm nothing is broken.

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: all tests PASS (existing tests + new priority tests).

- [ ] **Step 2: Verify existing tests are not broken by the list-ready refactor**

The `list-ready.mjs` change restructures the main loop from streaming to batch. Any test
that stubs `getEnriched()` or `listCards()` should still pass since the output shape is
unchanged. If any existing test breaks, fix it before proceeding.

- [ ] **Step 3: Bump plugin version**

```bash
# Edit .claude-plugin/plugin.json: bump "0.6.1" → "0.7.0"
git add .claude-plugin/plugin.json
git commit -m "chore: bump plugin version to 0.7.0"
```

- [ ] **Step 4: Push**

```bash
git push origin main
```
