# #58 + #59 + #60 — Uniform act-failure escalation in `routeVerdict`

**Date:** 2026-07-08
**Issues:** [#58](https://github.com/yarradev/yarradev-board/issues/58) (advance act_failed loops forever, no park), [#59](https://github.com/yarradev/yarradev-board/issues/59) (act_failed surfacing not extended to reject + link-pr/push), [#60](https://github.com/yarradev/yarradev-board/issues/60) (decomposed mid-loop CREATE failure doesn't escalate → partial-dup children)
**Status:** Design approved

Three follow-ups from #54's whole-branch review, all in `pass.mjs`'s `routeVerdict`. Unified under one rule.

## The rule

**Any load-bearing act that returns `!ok` (and isn't an already-handled special case) sets `actFailed` AND calls `escalate.mjs` (parks the card).** Fail-safe: park for a human ANSWER rather than loop forever or silently strand. Approved: escalate immediately, applied uniformly (no per-card counter / cross-pass state).

- **Load-bearing (park on failure):** the advance MOVE, the decomposed barrier MOVE, the decomposed child CREATEs, the reject MOVE (non-bounce), and the submitted `link-pr`/`push`.
- **Best-effort (unchanged, NOT escalated):** `reattach-ci.mjs` (CI recovery, explicitly non-fatal), `note`/`advice`/`fingerprint` (degraded, not stuck).
- **Already handled (unchanged):** the advance `advisor_clear` reshape and the reject bounce-budget escalate keep their existing dedicated paths.

## Fix — a `failAct` helper + uniform application

Introduce a closure inside `routeVerdict`:

```js
// Load-bearing act failed → surface (act_failed) AND park (escalate). Uniform across branches (#58/#59/#60).
const failAct = async (script, result, reason) => {
  actFailed = { script, result: result ?? null };
  await call("escalate.mjs", [id, reason]);
};
```

Apply per branch:

| Branch | Change | Issue |
|---|---|---|
| **advance** | on the unhandled MOVE failure (`!(mv && mv.ok) && !advisorClear422`) → `await failAct("move.mjs", mv, "advance act failed: " + <reason>)` | #58 |
| **decomposed barrier MOVE** | refactor the existing `actFailed + escalate` to call `failAct` (behavior identical, DRY) | #54→refactor |
| **decomposed mid-loop CREATE** | on `!r.ok` → `await failAct("create.mjs", r, "decompose CREATE failed")` before `break` | #60 |
| **reject** | on the non-bounce reject MOVE failure (the derived-edge `reject.mjs` result) → `failAct` | #59 |
| **submitted** | check `link-pr.mjs` / `push.mjs` results → on `!ok`, `failAct`; leave `reattach-ci.mjs` best-effort | #59 |

`reconcileVerdicts`'s existing `outcome: r.error ? "error" : r.actFailed ? "act_failed" : "routed"` mapping (from #54) already covers all of these — no reconcile change needed.

## Escalation idempotency (accepted, not over-engineered)

`escalate.mjs` posts an ASK → board sets `blocked=true` → `decide()` skips the card next pass → it isn't re-dispatched → doesn't re-fail → doesn't re-escalate. So one escalation per stuck card. If `escalate.mjs` itself fails (broader board outage), the card isn't parked and may re-dispatch — the same edge #54 already accepted.

## Components / files

- `skills/yarradev-run/scripts/pass.mjs` — `routeVerdict`: add `failAct`; apply to advance, reject, submitted, decomposed CREATE; refactor decomposed barrier to use it.
- `skills/yarradev-run/SKILL.md` — failure-map `act_failed` row: broaden from "advance + decomposed" to "all load-bearing reconcile-time acts (advance/reject/link-pr/push/create/barrier); reattach-ci stays best-effort".
- `.claude-plugin/plugin.json` — patch bump → **0.14.3**.

## Testing

- `routeVerdict` unit tests (extend `test/pass-routing.test.mjs`):
  - advance MOVE fail (non-advisor_clear) → `actFailed` **and** an `escalate.mjs` act. (#58 — the loop is now broken.)
  - advance `advisor_clear` → still no escalate, no actFailed (regression).
  - reject non-bounce MOVE fail → `actFailed` + escalate. (#59)
  - reject bounce-budget → still its existing escalate path, not double-escalated. (regression)
  - submitted `link-pr.mjs` fail → `actFailed` + escalate; `reattach-ci.mjs` fail alone → NOT escalated (best-effort). (#59)
  - decomposed mid-loop CREATE fail → `actFailed` + escalate. (#60)
  - happy paths (advance ok, reject ok, submitted ok, decomposed ok) → no escalate, no actFailed. (no false positives)
- Full suite green; the #54 parity + act_failed tests still pass.

## Version

Patch → **0.14.3**.
