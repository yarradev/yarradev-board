# #51 Native (in-session) Dispatch Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `native` dispatch mode so that, in a continuous interactive Claude Code session, role subagents are spawned through the host's `Agent` tool (status-line-visible) instead of a detached external `claude -p`, while `pass.mjs` stays the single brain (#39 selection/bounds/breaker/reconcile/routing all reused) and `claude -p` remains the default headless backend.

**Architecture:** The dispatch *executor* becomes pluggable. In `native` mode `dispatch.mjs` records the `pending` manifest entry + builds the combined prompt exactly as today but **does not spawn** — it emits a `dispatch-request` JSON line the LLM conductor fulfills via `Agent(background)`. When the agent completes, the conductor pipes its verdict into a new `dispatch.mjs --complete` helper that writes the verdict file + `done` entry, landing it where `pass.mjs`'s existing reconcile already looks. External and native are symmetric — only *who produces the verdict file* differs.

**Tech Stack:** Node ESM (built-ins only), `node:test` + `node:assert/strict`. Test runner: `npm test` (`node --test "test/*.test.mjs"`).

## Global Constraints

- **Zero external deps** — Node built-ins only.
- **External mode is byte-identical** — every change is gated behind `dispatchMode === "native"`; default stays `"external"`.
- **Reuse, don't duplicate** — native mode reuses `pendingEntry`/`doneEntry`/`parseFrontmatter`/`buildCombinedPrompt`/`worktreeFlagFor` (all already exported from `dispatch.mjs`) and all of `pass.mjs`'s reconcile/routing/bounds.
- **Tests** — pure helpers get `node:test` unit tests; CLI behavior is integration-tested by `spawnSync`-ing the script into a `mkdtempSync` sandbox with `XDG_DATA_HOME`/`YARRADEV_DISPATCH_STATE_DIR` pointed at the temp dir (mirrors the existing `dispatch.mjs.test.mjs` integration style). No live board, no `claude`, no `gh`.
- **Dispatch-request JSON shape** (the contract between `dispatch.mjs` native mode and the conductor):
  `{ action: "dispatch-request", role, cardId, verdictPath, gen, promptPath, model, effort, tools, worktreeFlag }`
  where `promptPath` is the **combined** prompt file (role instructions + card prompt), NOT the raw card prompt.
- **`dispatchMode`** is read from `cfg.runtime?.dispatchMode` (`"external" | "native"`, default `"external"`).

---

### Task 1: `dispatch.mjs` — native dispatcher mode (emit request instead of spawn)

**Files:**
- Modify: `skills/yarradev-run/scripts/dispatch.mjs` (add `buildDispatchRequest` export near the other pure helpers ~line 226; add the native branch in `invoke()` after the pending-entry append ~line 446)
- Test: `test/dispatch-native.test.mjs` (create)

**Interfaces:**
- Consumes: existing `pendingEntry`, `parseFrontmatter`, `buildCombinedPrompt`, `worktreeFlagFor`, `utcNow`.
- Produces: `buildDispatchRequest({ role, cardId, verdictPath, gen, promptPath, model, effort, tools, worktreeFlag }) => { action:"dispatch-request", role, cardId, verdictPath, gen, promptPath, model, effort, tools, worktreeFlag }`. Native `invoke()` prints `JSON.stringify(buildDispatchRequest(...))` on stdout (one line) and returns `verdictPath` **without** spawning a runner.

- [ ] **Step 1: Write the failing unit test for `buildDispatchRequest`**

Create `test/dispatch-native.test.mjs`:

```js
/*
 * dispatch-native.test.mjs — GH #51: native dispatch mode emits a dispatch-request for the host
 * conductor to fulfill via its Agent tool, instead of spawning an external `claude -p`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDispatchRequest } from "../skills/yarradev-run/scripts/dispatch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DISPATCH = join(HERE, "..", "skills", "yarradev-run", "scripts", "dispatch.mjs");

test("buildDispatchRequest: assembles the full request with action tag and combined promptPath", () => {
  const req = buildDispatchRequest({
    role: "developer", cardId: "card-1", verdictPath: "/t/v.txt", gen: "7",
    promptPath: "/t/prompt.txt", model: "sonnet", effort: "low", tools: "Read, Bash", worktreeFlag: "--worktree yarradev-card-1",
  });
  assert.deepEqual(req, {
    action: "dispatch-request", role: "developer", cardId: "card-1", verdictPath: "/t/v.txt", gen: "7",
    promptPath: "/t/prompt.txt", model: "sonnet", effort: "low", tools: "Read, Bash", worktreeFlag: "--worktree yarradev-card-1",
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -- --test-name-pattern="buildDispatchRequest: assembles"`
Expected: FAIL — `buildDispatchRequest` is not exported.

- [ ] **Step 3: Implement `buildDispatchRequest` and read the mode flag**

In `dispatch.mjs`, near the top constants (after the retry constants ~line 53), add:

```js
// #51: dispatch mode. "external" (default) spawns claude -p; "native" emits a dispatch-request for the host
// conductor to fulfill via its Agent tool (status-line-visible, in-session). Env-overridable for tests.
const DISPATCH_MODE = process.env.YARRADEV_DISPATCH_MODE ?? "external";
```

After `doneEntry` (~line 224), add:

```js
/**
 * Build the native-mode dispatch-request the host conductor fulfills via its Agent tool (GH #51). Pure.
 * `promptPath` is the COMBINED prompt (role instructions + card prompt), so the conductor can pass it
 * straight to the Agent tool. Shape is the contract SKILL.md's native protocol reads.
 * @returns {{action:"dispatch-request", role, cardId, verdictPath, gen, promptPath, model, effort, tools, worktreeFlag}}
 */
export function buildDispatchRequest({ role, cardId, verdictPath, gen, promptPath, model, effort, tools, worktreeFlag }) {
  return { action: "dispatch-request", role, cardId, verdictPath, gen, promptPath, model, effort, tools, worktreeFlag };
}
```

- [ ] **Step 4: Add the native branch in `invoke()`**

In `dispatch.mjs`, immediately after the pending-entry append in `invoke()` (the `appendFileSync(manifestPath, pendingEntry({...}) + "\n");` block ~line 443-446), insert the native short-circuit BEFORE the `runnerArgs`/spawn block:

```js
  // #51 native mode: do NOT spawn a runner. Emit the dispatch-request for the host conductor to fulfill via
  // its Agent tool; it will write the verdict + `done` entry via `dispatch.mjs --complete`. Pending is
  // already recorded above (so the in-flight filter + reconcile behave identically to external mode).
  if (DISPATCH_MODE === "native") {
    process.stdout.write(
      JSON.stringify(buildDispatchRequest({ role, cardId, verdictPath, gen, promptPath: combinedPromptPath, model, effort, tools, worktreeFlag })) + "\n",
    );
    return verdictPath;
  }
```

(The existing external `runnerArgs` → spawn → `process.stdout.write(verdictPath + "\n")` block runs only when not native.)

- [ ] **Step 5: Write the failing integration test for native `invoke()`**

Append to `test/dispatch-native.test.mjs`:

```js
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "yd-native-"));
  const agentsDir = join(dir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  // Minimal role file with frontmatter (model/effort/tools) + body.
  writeFileSync(join(agentsDir, "developer.md"), "---\nmodel: sonnet\neffort: low\ntools: Read, Bash, Edit\n---\nDo the dev work.\n");
  const promptFile = join(dir, "card-prompt.txt");
  writeFileSync(promptFile, "Card: implement X\n");
  return { dir, agentsDir, promptFile };
}

test("native invoke: prints a dispatch-request, records pending, does NOT block on a runner", () => {
  const { dir, promptFile } = sandbox();
  const r = spawnSync(process.execPath, [DISPATCH, "developer", "card-9", promptFile], {
    encoding: "utf8",
    env: {
      ...process.env,
      YARRADEV_DISPATCH_MODE: "native",
      XDG_DATA_HOME: dir,
      CLAUDE_PLUGIN_ROOT: dir, // resolveAgentFile → <root>/agents/<role>.md
    },
  });
  assert.equal(r.status, 0, r.stderr);
  const req = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(req.action, "dispatch-request");
  assert.equal(req.role, "developer");
  assert.equal(req.cardId, "card-9");
  assert.equal(req.model, "sonnet");
  assert.ok(req.verdictPath && req.promptPath, "carries verdictPath + promptPath");
  // combined prompt file exists and includes BOTH role body and card prompt
  const combined = readFileSync(req.promptPath, "utf8");
  assert.match(combined, /Do the dev work\./);
  assert.match(combined, /implement X/);
  // pending entry landed in the manifest under the sandbox state dir
  const manifest = readFileSync(join(dir, "claude-bg", "dispatch-manifest.jsonl"), "utf8");
  assert.match(manifest, /"status":"pending"[^\n]*"cardId":"card-9"/);
});
```

> Note: confirm the manifest path the sandbox writes to. `dispatch.mjs`'s `STATE_DIR = process.env.XDG_DATA_HOME ?? join(homedir(), ".local","share","claude-bg")` and `MANIFEST_FILE = join(STATE_DIR, "dispatch-manifest.jsonl")`. With `XDG_DATA_HOME=dir`, the manifest is `join(dir, "dispatch-manifest.jsonl")` (NOT under a `claude-bg` subdir). If the assertion path is wrong when you run it, read `STATE_DIR`/`MANIFEST_FILE` in `dispatch.mjs` and correct the test's path to match — do not change the source to fit the test.

- [ ] **Step 6: Run the native integration test**

Run: `npm test -- --test-name-pattern="native invoke"`
Expected: PASS (fix the manifest path per the Step-5 note if the first run mislocates it).

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS — all pre-existing `dispatch.mjs.test.mjs` tests plus the new file. External mode untouched.

- [ ] **Step 8: Commit**

```bash
git add skills/yarradev-run/scripts/dispatch.mjs test/dispatch-native.test.mjs
git commit -m "feat(dispatch): native mode — emit dispatch-request instead of spawning claude -p (#51)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `dispatch.mjs` — `--complete` helper (write verdict + `done` entry)

**Files:**
- Modify: `skills/yarradev-run/scripts/dispatch.mjs` (add a `--complete` branch in the CLI dispatch block ~line 630, alongside the `--run` branch; add exported `completeNative` for testability)
- Test: `test/dispatch-native.test.mjs` (extend)

**Interfaces:**
- Consumes: existing `doneEntry`, `MANIFEST_FILE`.
- Produces: CLI `node dispatch.mjs --complete <verdictPath> <cardId> --gen <g> --role <r>` — reads verdict text from **stdin**, writes it to `<verdictPath>`, appends a `done` manifest entry. Exit 0 on success, 2 on usage error. Exported `completeNative({ verdictText, verdictPath, cardId, gen, role, manifestPath }) => void` does the I/O (write verdict + append done) so it is unit-testable.

- [ ] **Step 1: Write the failing test**

Append to `test/dispatch-native.test.mjs`:

```js
test("--complete: writes the verdict file and appends a done manifest entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "yd-complete-"));
  const verdictPath = join(dir, "verdict.txt");
  const r = spawnSync(process.execPath, [DISPATCH, "--complete", verdictPath, "card-3", "--gen", "5", "--role", "tester"], {
    encoding: "utf8",
    input: "```json\n{\"status\":\"advance\",\"to\":\"done\"}\n```\n",
    env: { ...process.env, XDG_DATA_HOME: dir },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(verdictPath, "utf8"), /"status":"advance"/);
  const manifest = readFileSync(join(dir, "dispatch-manifest.jsonl"), "utf8");
  assert.match(manifest, /"status":"done"[^\n]*"cardId":"card-3"[^\n]*"gen":"5"/);
});
```

(Adjust the manifest path to match `MANIFEST_FILE` as in Task 1 Step 5 if needed.)

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -- --test-name-pattern="--complete: writes"`
Expected: FAIL — `--complete` is an unknown op (falls through to usage/`invoke`).

- [ ] **Step 3: Implement `completeNative` + the CLI branch**

In `dispatch.mjs`, after `doneEntry` / `buildDispatchRequest` (~line 226), add:

```js
/**
 * Native completion (GH #51): the host conductor calls this after its Agent-tool subagent returns, piping the
 * agent's final message (the verdict) on stdin. Writes the verdict file and appends the `done` manifest entry —
 * the exact artifacts `pass.mjs`'s reconcile consumes, so external and native land identically.
 * @param {{verdictText:string, verdictPath:string, cardId:string, gen:string, role:string, manifestPath:string}} o
 */
export function completeNative({ verdictText, verdictPath, cardId, gen, role, manifestPath }) {
  mkdirSync(dirname(verdictPath), { recursive: true });
  writeFileSync(verdictPath, verdictText);
  mkdirSync(dirname(manifestPath), { recursive: true });
  appendFileSync(manifestPath, doneEntry({ cardId, verdictPath, gen, role, completedAt: utcNow() }) + "\n");
}
```

Ensure `dirname` is imported from `node:path` at the top of `dispatch.mjs` (add it to the existing `import { ... } from "node:path"` if absent).

In the CLI dispatch block, immediately after the `if (argv[0] === "--run") { ... }` branch (~line 630-...), add:

```js
    // --- native completion (--complete <verdictPath> <cardId> --gen <g> --role <r>) ---
    if (argv[0] === "--complete") {
      const verdictPath = argv[1];
      const cardId = argv[2];
      if (!verdictPath || !cardId) {
        process.stderr.write("dispatch.mjs: --complete requires <verdictPath> <cardId>\n");
        process.exit(2);
      }
      const flags = parseRunnerFlags(argv.slice(3)); // reuses --gen/--role parsing
      const verdictText = readFileSync(0, "utf8"); // stdin
      completeNative({
        verdictText, verdictPath, cardId,
        gen: flags.gen ?? "", role: flags.role ?? "",
        manifestPath: MANIFEST_FILE,
      });
      process.exit(0);
    }
```

> `parseRunnerFlags` already tolerates unknown flags via its `default` case, so `--role` is captured as `out.role`. Verify `--gen` is captured (it is — explicit case). If `--role` needs an explicit case for clarity, add `case "--role": out.role = argv[++i] ?? ""; break;` to `parseRunnerFlags`.

- [ ] **Step 4: Run the test — verify it passes**

Run: `npm test -- --test-name-pattern="--complete: writes"`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add skills/yarradev-run/scripts/dispatch.mjs test/dispatch-native.test.mjs
git commit -m "feat(dispatch): --complete — land a native Agent verdict as verdict file + done entry (#51)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `pass.mjs` — `makeDispatch` native mode (thread mode, surface request)

**Files:**
- Modify: `skills/yarradev-run/scripts/pass.mjs` (`makeDispatch` ~line 795; add exported `parseNativeDispatchOutput`)
- Test: `test/pass-fanout.test.mjs` (extend) — or a small `test/pass-native.test.mjs`

**Interfaces:**
- Consumes: Task 1's dispatch-request JSON on `dispatch.mjs` stdout.
- Produces: `parseNativeDispatchOutput(stdout) => { verdictPath, requestLine }` (pure — parses the last non-empty stdout line as the dispatch-request JSON; throws on malformed). `makeDispatch(toolPath, mode = "external")` — when `mode === "native"`, spawns `dispatch.mjs` with `YARRADEV_DISPATCH_MODE=native`, parses via `parseNativeDispatchOutput`, echoes `requestLine` to `pass.mjs`'s own stdout (so the conductor sees the dispatch-request), and returns `verdictPath` (unchanged `dispatchNew` contract).

- [ ] **Step 1: Write the failing unit test for `parseNativeDispatchOutput`**

Create `test/pass-native.test.mjs`:

```js
/*
 * pass-native.test.mjs — GH #51: pass.mjs surfaces dispatch.mjs's native dispatch-request to the conductor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNativeDispatchOutput } from "../skills/yarradev-run/scripts/pass.mjs";

test("parseNativeDispatchOutput: extracts verdictPath + the raw request line", () => {
  const line = JSON.stringify({ action: "dispatch-request", role: "developer", cardId: "c1", verdictPath: "/t/v.txt", promptPath: "/t/p.txt" });
  const out = parseNativeDispatchOutput(line + "\n");
  assert.equal(out.verdictPath, "/t/v.txt");
  assert.equal(out.requestLine, line);
});

test("parseNativeDispatchOutput: ignores leading log noise, takes the last JSON line", () => {
  const line = JSON.stringify({ action: "dispatch-request", cardId: "c2", verdictPath: "/t/v2.txt" });
  const out = parseNativeDispatchOutput("some stderr bleed\n" + line + "\n");
  assert.equal(out.verdictPath, "/t/v2.txt");
});

test("parseNativeDispatchOutput: throws on malformed output", () => {
  assert.throws(() => parseNativeDispatchOutput("not json\n"));
  assert.throws(() => parseNativeDispatchOutput(""));
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -- --test-name-pattern="parseNativeDispatchOutput"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement `parseNativeDispatchOutput` and native `makeDispatch`**

In `pass.mjs`, just above `makeDispatch` (~line 795), add:

```js
/**
 * Parse dispatch.mjs's native-mode stdout (GH #51): the last non-empty line is the dispatch-request JSON.
 * Returns the parsed verdictPath and the raw request line (to re-emit to the conductor). Throws if absent/malformed.
 * @param {string} stdout
 * @returns {{verdictPath:string, requestLine:string}}
 */
export function parseNativeDispatchOutput(stdout) {
  const lines = (stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) throw new Error("native dispatch produced no output");
  const req = JSON.parse(last); // throws on malformed
  if (!req || req.action !== "dispatch-request" || !req.verdictPath) {
    throw new Error(`native dispatch output is not a dispatch-request: ${last.slice(0, 120)}`);
  }
  return { verdictPath: req.verdictPath, requestLine: last };
}
```

Change `makeDispatch` to take a `mode` and branch:

```js
export function makeDispatch(toolPath, mode = "external") {
  const externalTool = toolPath ?? process.env.YARRADEV_DISPATCH ?? null;
  const dispatchMjs = join(SCRIPTS_DIR, "dispatch.mjs");
  return async (role, cardId, promptFile) => {
    // #51 native mode: dispatch.mjs emits a dispatch-request instead of spawning; surface it to the conductor
    // (its Agent tool fulfills it) and return the verdictPath (unchanged dispatchNew contract).
    if (mode === "native") {
      const env = { ...sanitizeEnv(process.env), YARRADEV_DISPATCH_MODE: "native" };
      const r = spawnSync(process.execPath, [dispatchMjs, role, cardId, promptFile], { encoding: "utf8", env });
      if (r.status !== 0) throw new Error(`dispatch exited ${r.status}${r.stderr ? ` — ${r.stderr.trim()}` : ""}`);
      const { verdictPath, requestLine } = parseNativeDispatchOutput(r.stdout);
      process.stdout.write(requestLine + "\n"); // conductor reads this and fires an Agent(background) call
      return verdictPath;
    }
    const r = externalTool
      ? spawnSync(externalTool, [role, cardId, promptFile], { encoding: "utf8", env: sanitizeEnv(process.env) })
      : spawnSync(process.execPath, [dispatchMjs, role, cardId, promptFile], {
          encoding: "utf8",
          env: sanitizeEnv(process.env),
        });
    if (r.status !== 0) {
      throw new Error(`dispatch exited ${r.status}${r.stderr ? ` — ${r.stderr.trim()}` : ""}`);
    }
    const vp = (r.stdout ?? "").trim();
    if (!vp) throw new Error("dispatch printed no verdict path on stdout");
    return vp;
  };
}
```

- [ ] **Step 4: Run the tests — verify they pass**

Run: `npm test -- --test-name-pattern="parseNativeDispatchOutput"`
Expected: PASS (3 cases).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — the existing `makeDispatch` external callers are unaffected (default `mode="external"`).

- [ ] **Step 6: Commit**

```bash
git add skills/yarradev-run/scripts/pass.mjs test/pass-native.test.mjs
git commit -m "feat(pass): makeDispatch native mode — surface the dispatch-request to the conductor (#51)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Wire `dispatchMode` config, document the native protocol, bump version

**Files:**
- Modify: `skills/yarradev-run/scripts/pass.mjs` (main() — read `cfg.runtime?.dispatchMode`, pass to `makeDispatch`)
- Modify: `skills/yarradev-run/config/board.example.json` (add `runtime.dispatchMode`)
- Modify: `skills/yarradev-run/SKILL.md` (native per-pass protocol section)
- Modify: `.claude-plugin/plugin.json` (0.12.1 → 0.13.0)

**Interfaces:**
- Consumes: Task 3's `makeDispatch(toolPath, mode)`.
- Produces: nothing new (terminal wiring/docs task).

- [ ] **Step 1: Thread the mode in main()**

In `pass.mjs`, find `const dispatch = makeDispatch(cfg.runtime?.dispatchTool);` (in the CLI body) and change it to:

```js
  const dispatch = makeDispatch(cfg.runtime?.dispatchTool, cfg.runtime?.dispatchMode ?? "external");
```

- [ ] **Step 2: Verify the full suite still passes**

Run: `npm test`
Expected: PASS (default `"external"` → identical behavior).

- [ ] **Step 3: Surface the knob in the config template**

In `skills/yarradev-run/config/board.example.json`, find the `runtime` object (if present) and add `"dispatchMode": "external"`; if there is no `runtime` object, add one:

```json
  "runtime": { "dispatchMode": "external" },
```

(Place it as a sibling of `pace`/`budgets`. `external` = spawn `claude -p` (default, headless-safe); `native` = emit dispatch-requests the interactive Claude Code conductor fulfills via its Agent tool. Verify valid JSON — no trailing comma.)

- [ ] **Step 4: Document the native per-pass protocol in SKILL.md**

In `skills/yarradev-run/SKILL.md`, add a subsection under the per-pass procedure (near the `pass.mjs` PRIMARY block ~line 95, or the Discipline & safety section). Content (verbatim):

```markdown
### Native dispatch mode (interactive Claude Code — `runtime.dispatchMode: "native"`)

When `runtime.dispatchMode` is `"native"` and you (the conductor) are running in a continuous
interactive Claude Code session, `pass.mjs` does **not** spawn `claude -p`. Instead it emits one
`{"action":"dispatch-request", ...}` JSON line on stdout per card it selected (already bounded by
`pace.maxCardsPerPass`/`maxConcurrent` and the 529 breaker — do not re-bound). For each such line:

1. Read `promptPath` (the **combined** role+card prompt) — its contents are the subagent prompt.
2. Spawn the role subagent via the **`Agent` tool, `run_in_background`**, so it shows in the status line.
   Map `role` → `subagent_type`: write-capable roles (developer/releaser/tester/devops) →
   `general-purpose`; read-only advisors (code-reviewer/security-advisor/designer/analyst) → `Explore`.
   Pass `model` from the request.
3. When the agent completes (its `task-notification`), take its **final message** (the verdict block) and
   land it: `printf '%s' "<agent final message>" | node $S/dispatch.mjs --complete <verdictPath> <cardId> --gen <gen> --role <role>`.
   This writes the verdict file + `done` manifest entry — exactly what the next reconcile pass consumes.
4. Do nothing else — the **next** `pass.mjs` run reconciles the landed verdict and posts the act (routing,
   breaker, epic signals all unchanged). This is next-tick reconcile; latency ≤ one loop interval.

If you are **not** in an interactive session with an `Agent` tool (headless/cron), set
`dispatchMode: "external"` (the default) — `pass.mjs` spawns `claude -p` and this protocol does not apply.
```

- [ ] **Step 5: Bump the version**

In `.claude-plugin/plugin.json`, change `"version": "0.12.1",` to `"version": "0.13.0",` (new feature → minor bump).

- [ ] **Step 6: Full suite + import sanity**

Run: `npm test`
Expected: PASS (267 + the new native tests, 0 fail).

Run: `node -e "import('./skills/yarradev-run/scripts/pass.mjs').then(m => console.log(typeof m.parseNativeDispatchOutput))"`
Expected: `function`.

- [ ] **Step 7: Commit**

```bash
git add skills/yarradev-run/scripts/pass.mjs skills/yarradev-run/config/board.example.json skills/yarradev-run/SKILL.md .claude-plugin/plugin.json
git commit -m "feat: wire runtime.dispatchMode + document native dispatch protocol (#51, v0.13.0)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Pluggable executor, `pass.mjs` stays the brain → Tasks 1+3 (native emit + surface); reconcile/routing/bounds untouched. ✅
- Native backend emits dispatch-request, conductor fulfills via Agent tool → Task 1 (emit) + Task 4 SKILL.md protocol. ✅
- Conductor lands verdict where reconcile looks → Task 2 `--complete` helper (writes verdict + `done`). ✅
- Mode selector `runtime.dispatchMode`, default `external` → Task 4 (main wire + config template). ✅
- Next-tick reconcile → Task 4 SKILL.md step 4. ✅
- Out of scope (portability, session-restart durability) → not built; `dispatchMode` enum leaves room. ✅

**Refinements beyond the spec (noted for the reviewer):** the dispatch-request carries the **combined** prompt path + model/effort/tools (spec said just "verdict into verdictPath"); a `--complete` helper replaces the LLM hand-writing manifest JSON (robustness); role→`subagent_type` mapping is documented in the protocol. All within the approved design's intent.

**Placeholder scan:** none — every code step shows full code; commands have expected output. The two manifest-path notes (Task 1 Step 5, Task 2 Step 1) are explicit "verify against `MANIFEST_FILE`" instructions, not placeholders.

**Type consistency:** `buildDispatchRequest` output shape ≡ the Global-Constraints dispatch-request shape ≡ what `parseNativeDispatchOutput` reads (`action`/`verdictPath`) ≡ what SKILL.md's protocol consumes (`promptPath`/`model`/`verdictPath`/`gen`/`role`). `completeNative` params match the `--complete` CLI args + `doneEntry`'s shape. `makeDispatch(toolPath, mode)` matches the Task-4 call site.
