# #53 (widened) — Consolidated per-role config in `board.json` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `.yarradev/board.json` set per-role `model`/`effort`/`worktree`/`subagentType` via an optional `roles` block, so per-role dispatch config is per-project and survives `/plugin update` — collapsing the three hardcoded/plugin-owned sources (`agents/*.md` model/effort, `WORKTREE_ROLES`, the SKILL.md subagent_type map) into one overridable place, with byte-identical behavior when the block is absent.

**Architecture:** All resolution happens inside `dispatch.mjs` (the vendored, zero-dep portable dispatcher — it must NOT import `plugin-io.mjs`/`BoardClient`). A self-contained `loadRoleOverrides()` merges just the `roles` block across the three config layers; `invoke()` applies a per-field fallback chain at the single point where `model`/`effort`/`worktreeFlag` are already derived, and now also computes `subagentType`. Both dispatch backends inherit the overrides automatically because they read the same resolved variables (external → runner argv; native → the dispatch-request).

**Tech Stack:** Node ESM (built-ins only). Test runner: `npm test` (`node --test "test/*.test.mjs"`). Scoped runs: `node --test --test-name-pattern="<re>" test/<file>` (⚠️ `npm test -- --test-name-pattern` does NOT scope in this repo).

## Global Constraints

- **Zero external deps** — Node built-ins only. `dispatch.mjs` stays self-contained; do NOT import `plugin-io.mjs` or any board-client module into it.
- **Absent `roles` block ⇒ byte-identical to today.** Every override is `?? <existing default>`. `WORKTREE_ROLES` remains the default source; `agents/*.md` remains the model/effort default.
- **Per-field, per-role override.** A partial entry (`{ "tester": { "model": "haiku" } }`) changes only that field.
- **Fallback chain:** `model`/`effort` → `agents/<role>.md` frontmatter → hardcoded `sonnet`/`low`. `worktree` → `WORKTREE_ROLES.has(role)`. `subagentType` → `WORKTREE_ROLES.has(role) ? "general-purpose" : "Explore"`.
- **Config layers** (lowest→highest, per-role/per-field deep-merge): `<config>/board.example.json` ← `<config>/board.json` ← `<cwd>/.yarradev/board.json`. `<config>` = `join(dirname(dispatch.mjs), "..", "config")`.
- **Validation is non-fatal:** invalid `subagentType` (not `"general-purpose"`/`"Explore"`) or non-boolean `worktree` → drop that field (fall back), warn to stderr. Never throw.
- **Out of scope:** role prompt body/`description` (stay in `agents/*.md`), tokens (env-only), `tools` (stay in `agents/*.md`).
- **`subagentType` enum:** exactly `"general-purpose"` | `"Explore"`.

---

### Task 1: `dispatch.mjs` — merge + load the `roles` block

**Files:**
- Modify: `skills/yarradev-run/scripts/dispatch.mjs` (add `mergeRoles`, `sanitizeRoles`, `loadRoleOverrides` near the other exported helpers ~line 226)
- Test: `test/role-overrides.test.mjs` (create)

**Interfaces:**
- Produces:
  - `mergeRoles(baseRoles, installRoles, projectRoles) => { [role]: {model?,effort?,worktree?,subagentType?} }` — pure, deep per-role/per-field merge (higher layer wins per field). Nullish/absent layers treated as `{}`.
  - `sanitizeRoles(merged) => { cleaned, warnings:string[] }` — pure. Drops `subagentType` not in `{"general-purpose","Explore"}` and non-boolean `worktree`; keeps string `model`/`effort`. Records a warning per drop.
  - `loadRoleOverrides(opts?) => { [role]: {...} }` — reads `board.example.json` / `board.json` (from the config dir) and `<cwd>/.yarradev/board.json`, merges their `.roles`, sanitizes, warns to stderr. `opts.configDir`/`opts.cwd` injectable for tests; missing files → `{}`.

- [ ] **Step 1: Write the failing tests**

Create `test/role-overrides.test.mjs`:

```js
/*
 * role-overrides.test.mjs — GH #53: per-role config (model/effort/worktree/subagentType) from board.json.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeRoles, sanitizeRoles, loadRoleOverrides } from "../skills/yarradev-run/scripts/dispatch.mjs";

test("mergeRoles: higher layer overrides per field, lower fields survive", () => {
  const out = mergeRoles(
    { developer: { model: "sonnet", worktree: true } },
    { developer: { model: "opus" } },
    { developer: { effort: "high" } },
  );
  assert.deepEqual(out, { developer: { model: "opus", worktree: true, effort: "high" } });
});

test("mergeRoles: absent/nullish layers are treated as empty", () => {
  assert.deepEqual(mergeRoles(undefined, { tester: { model: "haiku" } }, null), { tester: { model: "haiku" } });
});

test("sanitizeRoles: drops invalid subagentType and non-boolean worktree, keeps the rest", () => {
  const { cleaned, warnings } = sanitizeRoles({
    developer: { model: "opus", subagentType: "Frobnicate", worktree: "yes" },
    tester: { model: "haiku", subagentType: "Explore", worktree: true },
  });
  assert.deepEqual(cleaned, {
    developer: { model: "opus" },
    tester: { model: "haiku", subagentType: "Explore", worktree: true },
  });
  assert.equal(warnings.length, 2);
});

test("loadRoleOverrides: merges .roles across example/install/project layers", () => {
  const dir = mkdtempSync(join(tmpdir(), "yd-roles-"));
  const configDir = join(dir, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "board.example.json"), JSON.stringify({ roles: { developer: { model: "sonnet" } } }));
  // no install board.json
  const cwd = join(dir, "proj");
  mkdirSync(join(cwd, ".yarradev"), { recursive: true });
  writeFileSync(join(cwd, ".yarradev", "board.json"), JSON.stringify({ roles: { developer: { model: "opus", worktree: false } } }));
  const out = loadRoleOverrides({ configDir, cwd });
  assert.deepEqual(out, { developer: { model: "opus", worktree: false } });
});

test("loadRoleOverrides: no config files → {}", () => {
  const dir = mkdtempSync(join(tmpdir(), "yd-roles-empty-"));
  assert.deepEqual(loadRoleOverrides({ configDir: join(dir, "config"), cwd: join(dir, "proj") }), {});
});
```

- [ ] **Step 2: Run — verify they fail**

Run: `node --test --test-name-pattern="mergeRoles|sanitizeRoles|loadRoleOverrides" test/role-overrides.test.mjs`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement the three functions**

In `dispatch.mjs`, after `buildDispatchRequest` (~line 226), add. (`readFileSync`, `existsSync`, `join`, `dirname` are already imported; confirm and add any missing to the existing `node:fs`/`node:path` imports.)

```js
const SUBAGENT_TYPES = new Set(["general-purpose", "Explore"]);

/**
 * Deep per-role/per-field merge of the `roles` blocks from the config layers (lowest→highest). Pure.
 * @returns {Object<string, {model?:string, effort?:string, worktree?:boolean, subagentType?:string}>}
 */
export function mergeRoles(baseRoles, installRoles, projectRoles) {
  const layers = [baseRoles, installRoles, projectRoles].map((r) => (r && typeof r === "object" ? r : {}));
  const out = {};
  for (const layer of layers) {
    for (const [role, entry] of Object.entries(layer)) {
      if (entry && typeof entry === "object") out[role] = { ...(out[role] ?? {}), ...entry };
    }
  }
  return out;
}

/**
 * Drop invalid fields from a merged roles map (invalid subagentType / non-boolean worktree), keeping valid
 * model/effort/worktree/subagentType. Pure. Returns the cleaned map + a warning per dropped field. #53.
 * @returns {{cleaned:Object, warnings:string[]}}
 */
export function sanitizeRoles(merged) {
  const cleaned = {};
  const warnings = [];
  for (const [role, entry] of Object.entries(merged ?? {})) {
    if (!entry || typeof entry !== "object") continue;
    const c = {};
    if (typeof entry.model === "string") c.model = entry.model;
    if (typeof entry.effort === "string") c.effort = entry.effort;
    if ("worktree" in entry) {
      if (typeof entry.worktree === "boolean") c.worktree = entry.worktree;
      else warnings.push(`roles.${role}.worktree must be boolean; ignoring ${JSON.stringify(entry.worktree)}`);
    }
    if ("subagentType" in entry) {
      if (SUBAGENT_TYPES.has(entry.subagentType)) c.subagentType = entry.subagentType;
      else warnings.push(`roles.${role}.subagentType must be one of ${[...SUBAGENT_TYPES].join("/")}; ignoring ${JSON.stringify(entry.subagentType)}`);
    }
    cleaned[role] = c;
  }
  return { cleaned, warnings };
}

/** Read a JSON file's parsed content, or {} if absent/unreadable. */
function readJsonOr(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  } catch {
    return {};
  }
}

/**
 * Load the merged, sanitized per-role overrides from the config layers (GH #53). Self-contained (no board
 * client). `opts.configDir` defaults to `<dispatch.mjs dir>/../config`; `opts.cwd` to `process.cwd()`.
 * @returns {Object<string, {model?:string, effort?:string, worktree?:boolean, subagentType?:string}>}
 */
export function loadRoleOverrides(opts = {}) {
  const configDir = opts.configDir ?? join(dirname(__filename), "..", "config");
  const cwd = opts.cwd ?? process.cwd();
  const base = readJsonOr(join(configDir, "board.example.json")).roles;
  const install = readJsonOr(join(configDir, "board.json")).roles;
  const project = readJsonOr(join(cwd, ".yarradev", "board.json")).roles;
  const { cleaned, warnings } = sanitizeRoles(mergeRoles(base, install, project));
  for (const w of warnings) process.stderr.write(`dispatch.mjs: ${w}\n`);
  return cleaned;
}
```

- [ ] **Step 4: Run — verify pass**

Run: `node --test test/role-overrides.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: PASS (existing + the new file).

- [ ] **Step 6: Commit**

```bash
git add skills/yarradev-run/scripts/dispatch.mjs test/role-overrides.test.mjs
git commit -m "feat(dispatch): loadRoleOverrides — merge per-role config from board.json layers (#53)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: extend `worktreeFlagFor` + `buildDispatchRequest`

**Files:**
- Modify: `skills/yarradev-run/scripts/dispatch.mjs` (`worktreeFlagFor` ~line 153, `buildDispatchRequest` ~line 232)
- Test: `test/dispatch.mjs.test.mjs` (extend — where `worktreeFlagFor` is already tested) and `test/dispatch-native.test.mjs` (extend — where `buildDispatchRequest` shape lives)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `worktreeFlagFor(role, cardId, override)` — `override` (boolean|undefined). When `override` is a boolean it wins; when `undefined`, falls back to `WORKTREE_ROLES.has(role)`. Return unchanged otherwise (`--worktree yarradev-<cardId>` or `""`).
  - `buildDispatchRequest({..., subagentType})` — adds a `subagentType` field to the emitted request object (after `worktreeFlag`).

- [ ] **Step 1: Write failing tests**

Append to `test/dispatch.mjs.test.mjs` (near the existing `worktreeFlagFor` tests):

```js
test("worktreeFlagFor: explicit override=true forces the flag even for a read-only role", () => {
  assert.equal(worktreeFlagFor("designer", "c1", true), "--worktree yarradev-c1");
});
test("worktreeFlagFor: explicit override=false suppresses the flag even for a write role", () => {
  assert.equal(worktreeFlagFor("developer", "c1", false), "");
});
test("worktreeFlagFor: override=undefined keeps the WORKTREE_ROLES default", () => {
  assert.equal(worktreeFlagFor("developer", "c1", undefined), "--worktree yarradev-c1");
  assert.equal(worktreeFlagFor("designer", "c1", undefined), "");
});
```

Append to `test/dispatch-native.test.mjs`:

```js
test("buildDispatchRequest: carries subagentType", () => {
  const req = buildDispatchRequest({
    role: "developer", cardId: "c1", verdictPath: "/v", gen: "1", promptPath: "/p",
    model: "opus", effort: "high", tools: "Read", worktreeFlag: "--worktree yarradev-c1", subagentType: "general-purpose",
  });
  assert.equal(req.subagentType, "general-purpose");
  assert.equal(req.action, "dispatch-request");
});
```

(Ensure `worktreeFlagFor` and `buildDispatchRequest` are in the respective files' import lists.)

- [ ] **Step 2: Run — verify fail**

Run: `node --test --test-name-pattern="worktreeFlagFor: explicit|override=undefined|carries subagentType" test/dispatch.mjs.test.mjs test/dispatch-native.test.mjs`
Expected: FAIL (override arg ignored → 3rd-arg tests fail; `subagentType` undefined).

- [ ] **Step 3: Implement**

Replace `worktreeFlagFor` (~line 153):

```js
/**
 * The `--worktree yarradev-<cardId>` flag for a role, or "". `override` (boolean|undefined) from board.json's
 * roles block wins when set; otherwise falls back to the WORKTREE_ROLES default (#42/#53).
 * @param {string} role
 * @param {string} cardId
 * @param {boolean} [override]
 * @returns {string}
 */
export function worktreeFlagFor(role, cardId, override) {
  const worktree = typeof override === "boolean" ? override : WORKTREE_ROLES.has(role);
  return worktree ? `--worktree yarradev-${cardId}` : "";
}
```

Update `buildDispatchRequest` (~line 232) to thread `subagentType`:

```js
export function buildDispatchRequest({ role, cardId, verdictPath, gen, promptPath, model, effort, tools, worktreeFlag, subagentType }) {
  return { action: "dispatch-request", role, cardId, verdictPath, gen, promptPath, model, effort, tools, worktreeFlag, subagentType };
}
```

- [ ] **Step 4: Run — verify pass**

Run: `node --test test/dispatch.mjs.test.mjs test/dispatch-native.test.mjs`
Expected: PASS (existing + new). Note: `worktreeFlagFor`'s existing 2-arg callers still pass (3rd arg `undefined` → default path).

- [ ] **Step 5: Full suite + commit**

Run: `npm test` → PASS.

```bash
git add skills/yarradev-run/scripts/dispatch.mjs test/dispatch.mjs.test.mjs test/dispatch-native.test.mjs
git commit -m "feat(dispatch): worktreeFlagFor override arg + subagentType on dispatch-request (#53)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: wire overrides into `invoke()` (both backends)

**Files:**
- Modify: `skills/yarradev-run/scripts/dispatch.mjs` (`invoke()` ~lines 451–495)
- Test: `test/dispatch-native.test.mjs` (extend — integration)

**Interfaces:**
- Consumes: `loadRoleOverrides` (Task 1), `worktreeFlagFor(role, cardId, override)` + `buildDispatchRequest({...,subagentType})` (Task 2), existing `WORKTREE_ROLES`.
- Produces: nothing new — `invoke()` now resolves per-role overrides and emits them into the native request and the external runner argv.

- [ ] **Step 1: Write the failing integration test**

Append to `test/dispatch-native.test.mjs` (reuses the `sandbox()` helper from earlier in the file — it writes `agents/developer.md` with `model: sonnet` and a card prompt):

```js
test("native invoke: board.json roles override model/worktree/subagentType in the emitted request", () => {
  const { dir, promptFile } = sandbox();
  // agents/developer.md ships model:sonnet, developer is a WORKTREE_ROLES member (worktree default true).
  // Override: model→opus, worktree→false, subagentType→Explore in a project .yarradev/board.json.
  const cwd = join(dir, "proj");
  mkdirSync(join(cwd, ".yarradev"), { recursive: true });
  writeFileSync(join(cwd, ".yarradev", "board.json"),
    JSON.stringify({ roles: { developer: { model: "opus", worktree: false, subagentType: "Explore" } } }));
  const r = spawnSync(process.execPath, [DISPATCH, "developer", "card-ov", promptFile], {
    encoding: "utf8", cwd,
    env: { ...process.env, YARRADEV_DISPATCH_MODE: "native", XDG_DATA_HOME: dir, CLAUDE_PLUGIN_ROOT: dir },
  });
  assert.equal(r.status, 0, r.stderr);
  const req = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(req.model, "opus", "model overridden");
  assert.equal(req.worktreeFlag, "", "worktree:false suppresses the flag");
  assert.equal(req.subagentType, "Explore", "subagentType overridden");
});

test("native invoke: absent roles block → agents/*.md model + WORKTREE_ROLES defaults", () => {
  const { dir, promptFile } = sandbox();
  const cwd = join(dir, "proj-default");
  mkdirSync(cwd, { recursive: true });
  const r = spawnSync(process.execPath, [DISPATCH, "developer", "card-def", promptFile], {
    encoding: "utf8", cwd,
    env: { ...process.env, YARRADEV_DISPATCH_MODE: "native", XDG_DATA_HOME: dir, CLAUDE_PLUGIN_ROOT: dir },
  });
  assert.equal(r.status, 0, r.stderr);
  const req = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(req.model, "sonnet", "falls back to agents/developer.md");
  assert.equal(req.worktreeFlag, "--worktree yarradev-card-def", "WORKTREE_ROLES default");
  assert.equal(req.subagentType, "general-purpose", "write-role default");
});
```

> The override reads `<cwd>/.yarradev/board.json`; `loadRoleOverrides` uses `process.cwd()`, and the child's cwd is set via `spawnSync`'s `cwd` option — so the override is only seen when `cwd` points at the project with the `.yarradev/board.json`. Confirm the sandbox writes `agents/developer.md` under `CLAUDE_PLUGIN_ROOT=dir`.

- [ ] **Step 2: Run — verify fail**

Run: `node --test --test-name-pattern="board.json roles override|absent roles block" test/dispatch-native.test.mjs`
Expected: FAIL (override not applied yet — model stays sonnet, worktree stays set, subagentType absent).

- [ ] **Step 3: Wire `invoke()`**

In `dispatch.mjs`'s `invoke()`, replace the frontmatter/worktree derivation (~lines 451, 463). Current:

```js
  const { model, effort, tools, body } = parseFrontmatter(agentContent);
```
…
```js
  const worktreeFlag = worktreeFlagFor(role, cardId);
```

with (apply overrides + compute subagentType):

```js
  const { model: fmModel, effort: fmEffort, tools, body } = parseFrontmatter(agentContent);
  const overrides = loadRoleOverrides()[role] ?? {};
  const model = overrides.model ?? fmModel;
  const effort = overrides.effort ?? fmEffort;
```
…
```js
  const worktreeFlag = worktreeFlagFor(role, cardId, overrides.worktree);
  const subagentType = overrides.subagentType ?? (WORKTREE_ROLES.has(role) ? "general-purpose" : "Explore");
```

Then add `subagentType` to the native `buildDispatchRequest(...)` call (~line 480):

```js
      JSON.stringify(buildDispatchRequest({ role, cardId, verdictPath, gen, promptPath: combinedPromptPath, model, effort, tools, worktreeFlag, subagentType })) + "\n",
```

The external runner argv already consumes `model`/`effort`/`worktreeFlag` — now the overridden values — so no change is needed there.

- [ ] **Step 4: Run — verify pass**

Run: `node --test test/dispatch-native.test.mjs`
Expected: PASS (override + default-fallback integration tests, plus all earlier native tests).

- [ ] **Step 5: Full suite + commit**

Run: `npm test` → PASS.

```bash
git add skills/yarradev-run/scripts/dispatch.mjs test/dispatch-native.test.mjs
git commit -m "feat(dispatch): apply per-role board.json overrides in invoke() — both backends (#53)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: SKILL.md protocol, config template note, version bump

**Files:**
- Modify: `skills/yarradev-run/SKILL.md` (native protocol step 2 — use `request.subagentType`)
- Modify: `skills/yarradev-run/config/board.example.json` (add a `_roles_note` documenting the optional block — NO active `roles` block, so the default fallback path stays the shipped behavior)
- Modify: `.claude-plugin/plugin.json` (→ `0.14.0`)

**Interfaces:**
- Consumes: the `subagentType` field now emitted on the native dispatch-request (Task 3).
- Produces: nothing new (terminal docs/config task).

- [ ] **Step 1: Point SKILL.md at `request.subagentType`**

In `skills/yarradev-run/SKILL.md`, native protocol step 2, replace the hardcoded role→subagent_type mapping lines:

```
   Map `role` → `subagent_type`: write-capable roles (developer/releaser/tester/devops) →
   `general-purpose`; read-only advisors (code-reviewer/security-advisor/designer/analyst) → `Explore`.
   Pass `model` from the request. If the request's `worktreeFlag` is non-empty …
```
with:
```
   Use the request's `subagentType` field as the `Agent` tool's `subagent_type` (`dispatch.mjs` resolves it
   from `board.json`'s `roles` block, else the write/read default). Pass `model` from the request. If the
   request's `worktreeFlag` is non-empty …
```

(Keep the existing `worktreeFlag` → `isolation: "worktree"` sentence intact — only the role→type mapping sentence changes.)

- [ ] **Step 2: Document the optional `roles` block in the template**

In `skills/yarradev-run/config/board.example.json`, add a sibling note key (mirrors the existing `_budgets_note`/`_epic_note` convention). Do NOT add an active `"roles"` object (an active block would override `agents/*.md` for every consumer; absence preserves the default). Add:

```json
  "_roles_note": "Optional per-role dispatch overrides (GH #53): add a \"roles\" block, e.g. { \"tester\": { \"model\": \"haiku\" }, \"designer\": { \"model\": \"opus\", \"worktree\": false, \"subagentType\": \"Explore\" } }. Each field is optional and overrides the agents/<role>.md default (model/effort) or the built-in default (worktree ← WORKTREE_ROLES; subagentType ← write→general-purpose else Explore). Absent = today's behavior.",
```

Verify valid JSON: `node -e "JSON.parse(require('fs').readFileSync('skills/yarradev-run/config/board.example.json','utf8'))"` — must not throw.

- [ ] **Step 3: Version bump**

In `.claude-plugin/plugin.json`, set `"version": "0.14.0"`.

- [ ] **Step 4: Full suite + sanity**

Run: `npm test` → PASS (all prior + role-overrides).
Run: `node -e "import('./skills/yarradev-run/scripts/dispatch.mjs').then(m => console.log(typeof m.loadRoleOverrides, typeof m.mergeRoles))"` → `function function`.

- [ ] **Step 5: Commit**

```bash
git add skills/yarradev-run/SKILL.md skills/yarradev-run/config/board.example.json .claude-plugin/plugin.json
git commit -m "feat: document per-role board.json config + native subagentType wiring (#53, v0.14.0)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- `roles` block (model/effort/worktree/subagentType), per-field override → Tasks 1+3. ✅
- Fallback chain, absent-block byte-identical → Task 3's default test + `?? default` wiring. ✅
- `loadRoleOverrides` self-contained in `dispatch.mjs` (not `plugin-io.mjs`, to keep the vendored dispatcher zero-dep) → Task 1 (refinement from spec, noted). ✅
- Collapses D (`WORKTREE_ROLES` overridable) + E (emit `subagentType`, SKILL.md consumes it) + F (model/effort) → Tasks 2/3/4. ✅
- Both backends → Task 3 (external argv + native request read the same resolved vars). ✅
- Validation non-fatal → `sanitizeRoles` (Task 1). ✅
- Out of scope (prompt/tokens/tools) → untouched. ✅
- v0.14.0 → Task 4. ✅

**Placeholder scan:** none — every code step shows full code; commands have expected output.

**Type consistency:** `mergeRoles`/`sanitizeRoles`/`loadRoleOverrides` shapes match across tasks; `worktreeFlagFor(role, cardId, override?)` and `buildDispatchRequest({...,subagentType})` signatures match their Task-3 call sites; the `subagentType` enum (`general-purpose`/`Explore`) is consistent in `sanitizeRoles`, the default derivation, and SKILL.md.

**Refinement beyond the spec (noted for reviewer):** `loadRoleOverrides` lives in `dispatch.mjs` (self-contained), not `plugin-io.mjs` — required because `dispatch.mjs` is the vendored zero-dep dispatcher and must not import the board client. Functionally identical to the spec's intent.
