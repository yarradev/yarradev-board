# #53 (widened) — Consolidated per-role config in `board.json`

**Date:** 2026-07-08
**Issue:** [#53](https://github.com/yarradev/yarradev-board/issues/53) — no per-role model/effort override; `dispatch.mjs` only reads plugin `agents/*.md`, which reverts on every `/plugin update`
**Status:** Design approved

## Problem

Per-role dispatch config is fragmented across three plugin-owned / hardcoded places, none per-project or update-safe:
- **model / effort** — only in `agents/<role>.md` frontmatter (plugin cache; overwritten by `/plugin update`).
- **worktree eligibility** — hardcoded `WORKTREE_ROLES = {developer, releaser, tester, devops}` (`dispatch.mjs:69`).
- **native `subagent_type`** — hardcoded prose map in SKILL.md (`write→general-purpose`, read-only→`Explore`).

The "is this role a repo-mutator" concept is expressed three times and can't be derived from `tools` (tester/releaser mutate via `Bash`, not the `Write` tool). #53 asked for model/effort override; this widens it to consolidate all four facets into one per-project, update-safe `roles` block.

## Design — a `roles` block in `board.json`

```jsonc
"roles": {
  "developer": { "model": "opus",   "effort": "high", "worktree": true,  "subagentType": "general-purpose" },
  "tester":    { "model": "sonnet", "effort": "low",  "worktree": true,  "subagentType": "general-purpose" },
  "designer":  { "model": "opus",   "effort": "high", "worktree": false, "subagentType": "Explore" }
}
```

All fields optional; per-field override. A partial block (`{ "tester": { "model": "haiku" } }`) changes only that field for that role. **Decoupled flags** (`worktree` and `subagentType` independent) per the approved modeling decision.

### Fallback chain (per field, when absent from `roles`)

| Field | Falls back to |
|---|---|
| `model` / `effort` | `agents/<role>.md` frontmatter → then the existing `sonnet` / `low` hardcoded defaults |
| `worktree` | `WORKTREE_ROLES.has(role)` (today's hardcoded set) |
| `subagentType` | `WORKTREE_ROLES.has(role) ? "general-purpose" : "Explore"` (today's SKILL.md map) |

**Absent `roles` block ⇒ byte-identical to today.** `WORKTREE_ROLES` remains the default source, now overridable.

## Where it's read — `loadRoleOverrides()` helper

`dispatch.mjs` already derives model/effort (from `agents/*.md`) and `worktreeFlag` (from `WORKTREE_ROLES`) itself, but does **not** load board config today (lean subprocess: env + agent files only). We add a focused helper rather than pulling in full `loadConfig` (which throws on missing `apiBase`/`doName`):

- **`loadRoleOverrides()`** (new, exported from `plugin-io.mjs`) — merges *only* the `roles` block across the three config layers (`board.example.json` ← `board.json` ← project `.yarradev/board.json`), deep per-role/per-field, and returns `{ [role]: { model?, effort?, worktree?, subagentType? } }`. No `apiBase`/`doName`/`lifecycle` validation. Missing files → `{}`. The file-merge core is factored so it is unit-testable with injected content (no fs in the pure part).
- `dispatch.mjs`'s `invoke()` calls it once and applies the fallback chain at the single point where model/effort/worktreeFlag are already computed.

`dispatch.mjs` is spawned with the conductor's cwd (the project root), so `process.cwd()/.yarradev/board.json` resolves correctly.

## What this collapses

- **model/effort (F)** → `roles` block (the #53 ask).
- **worktree (D)** → `roles.<role>.worktree`; `WORKTREE_ROLES` becomes the default, not the only source.
- **native subagent_type (E)** → `dispatch.mjs` now **emits `subagentType` on the native dispatch-request** (new field). SKILL.md native protocol step 2 changes from "map `role`→`subagent_type` yourself" to "**use the request's `subagentType`**." The prose map becomes the code fallback, no longer hand-applied by the conductor.

## Applied at both dispatch backends

- **External** (`claude -p`): resolved `model`/`effort` → `--model`/`--effort`; resolved `worktree` → the `--worktree yarradev-<cardId>` flag (or empty).
- **Native** (#51): resolved `model` → request `model`; resolved `worktree` → request `worktreeFlag`; resolved `subagentType` → the new request field.

## Deliberately out of scope

- **Prompt body + `description`** stay in `agents/<role>.md` (multi-KB prose belongs in markdown, not a JSON string).
- **Tokens** stay env-only (`YDB_TOKEN_<ROLE>`) — secrets never enter committed config.
- **`tools`** stay in `agents/*.md` (changing a subagent's toolset is riskier than model/effort and wasn't the ask; the block can gain `tools` later without rework).

## Validation

Light schema check on the `roles` block: `subagentType ∈ {"general-purpose", "Explore"}`, `worktree` is boolean, `model`/`effort` are strings. Invalid values → ignored (fall back) with a stderr warning, never fatal.

## Testing

- `loadRoleOverrides` (pure merge core): example-only, per-role/per-field override across layers, absent block → `{}`, invalid field → dropped.
- `dispatch.mjs` native `invoke()` integration: a `roles` override for `model`/`worktree`/`subagentType` is reflected in the emitted `dispatch-request`; absent override falls back to `agents/*.md` + `WORKTREE_ROLES`.
- External path: resolved `model`/`effort`/`worktree` flow into the runner argv (assert via the existing spawn-injection style).
- Full suite stays green; absent-block behavior byte-identical.

## Version

Minor bump → **0.14.0** (new capability).
