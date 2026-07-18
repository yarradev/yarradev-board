#!/usr/bin/env node
/*
 * pass.mjs — the per-pass orchestrator (GH #28). Replaces the conductor's SKILL.md step 2/3 prose loop with
 * deterministic code. Each invocation does TWO things and yields (non-blocking, /loop-driven):
 *
 *   1. RECONCILE — scan the dispatch manifest for `done` verdicts not yet processed (from this pass AND
 *      still-running dispatches from prior passes). For each: re-CLAIM (fresh gen — sidesteps the stale gen
 *      from lease-TTL expiry; this is the #27 recovery gap fix), route the verdict to the right act script,
 *      post, CLEAR_LEASE, mark consumed.
 *   2. DISPATCH — for up to K=pace.maxCardsPerPass actionable cards (deps resolved, not in-flight):
 *      CLAIM + build-prompt + fire-and-forget `yarradev-dispatch` (records a `pending` manifest entry).
 *
 * CRITICAL INVARIANT: this script REUSES the existing act scripts (claim/move/reject/link-pr/push/advice/
 * veto/hold/note/escalate/create/fingerprint/build-prompt/reattach-ci) via `child_process.spawnSync` (or an
 * injected `run` for testability). It does NOT re-implement any act-posting logic — it ports only the
 * ROUTING (verdict → which script + args) from SKILL.md step 2/3. The act scripts stay the source of truth.
 *
 * Routing parity — routeVerdict matches SKILL.md step 2/3 EXACTLY. The async reshape (spec §Routing parity):
 * the same-pass inline advisor (422 blocked_by ⊇ advisor_clear) becomes a fire-and-forget advisor dispatch
 * reconciled NEXT pass (NOT same-pass).
 *
 * Zero deps (Node built-ins only). ESM. No top-level execution on import (CLI body guarded by import.meta.url).
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveLifecycle } from "./plugin-io.mjs";
import { inFlightCardIds } from "./in-flight.mjs";
import { stateDir as resolveStateDir, manifestPath as resolveManifestPath } from "./runner/paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCRIPTS_DIR = HERE;

// State/manifest dir routed through runner/paths.mjs (the single source of truth dispatch and pass share).
const CONSUMED_NAME = "dispatch-consumed.jsonl";
const CONTEXT_NAME = "dispatch-context.jsonl";
const BREAKER_NAME = "dispatch-breaker.json";

// ============================================================================
// Pure helpers (no I/O — the testable surface)
// ============================================================================

/**
 * Parse the LAST fenced ```json block from a verdict file's text into an object, or null if none / malformed.
 * Mirrors SKILL.md step 2c ("parse the last fenced ```json block"). Tolerates a bare ``` fence (no `json`
 * lang tag), 4-backtick fences (escaped), surrounding whitespace, and an unclosed fence at EOF (a truncated
 * verdict from a crashed subagent still yields its block). If multiple blocks parse, the LAST valid one wins
 * (the verdict is conventionally the final block; earlier blocks are intermediate "thinking").
 * @param {string|null|undefined} text
 * @returns {object|null}
 */
export function parseLastVerdict(text) {
  if (!text || typeof text !== "string") return null;
  // Opening fence: 3+ backticks, optional `json` lang tag, optional trailing space, then a newline.
  // Body: lazy. Closing: a line that is exactly the same backtick count (backreference \1) OR end-of-string
  // (handles an unclosed final fence). The `m` flag makes ^/$ match line boundaries.
  const re = /(`{3,})(json)?[^\S\r\n]*\r?\n([\s\S]*?)(?:^[^\S\r\n]*\1[^\S\r\n]*$|$(?![\s\S]))/gmi;
  let last = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    const body = m[3];
    if (body != null) {
      try {
        last = JSON.parse(body.trim());
      } catch {
        // malformed block — keep the previous valid `last` (a trailing malformed fence shouldn't discard
        // an earlier valid verdict; if there's only the one malformed block, last stays null).
      }
    }
  }
  return last;
}

/**
 * Parse the dispatcher's bare error-envelope line (GH #44). When `claude -p` fails (gateway 529 / crash /
 * empty), `yarradev-dispatch` appends a bare `{"status":"error","error_type":"…","detail":"…"}` line to the
 * verdict file. This finds the LAST such line so the conductor can distinguish a dispatch error (a gateway
 * outage) from a genuine no-verdict (a card stall) — instead of masking both as "no parseable block".
 * Returns null when there's no envelope (the verdict is a real block, or truly empty).
 * @param {string|null|undefined} text
 * @returns {{status:"error", error_type:string, detail?:string}|null}
 */
export function parseErrorEnvelope(text) {
  if (!text || typeof text !== "string") return null;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t.startsWith("{") || !t.endsWith("}")) continue;
    try {
      const e = JSON.parse(t);
      if (e && e.status === "error" && typeof e.error_type === "string") return e;
    } catch {
      /* not the envelope line — keep scanning */
    }
  }
  return null;
}

/**
 * Return the `done` manifest entries whose verdictPath is NOT in the consumed ledger. Pure over the manifest
 * + consumed JSONL contents (mirrors in-flight.mjs's walk style). Skips pending, malformed, and entries
 * missing cardId/verdictPath. Preserves manifest order; the consumed-ledger dedups across passes.
 * @param {string|null|undefined} manifestContent raw JSONL
 * @param {string|null|undefined} consumedContent raw JSONL ({"verdictPath","consumedAt"} per line)
 * @returns {Array<{cardId:string, verdictPath:string, role?:string, [k:string]:any}>}
 */
export function nextUnconsumedDone(manifestContent, consumedContent) {
  const consumed = new Set();
  if (consumedContent) {
    for (const line of consumedContent.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t);
        if (e && typeof e.verdictPath === "string") consumed.add(e.verdictPath);
      } catch {
        continue; // malformed consumed line — skip, never crash reconciliation
      }
    }
  }
  const out = [];
  if (!manifestContent) return out;
  for (const line of manifestContent.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try {
      e = JSON.parse(t);
    } catch {
      continue; // malformed manifest line — skip
    }
    if (!e || e.status !== "done") continue; // only landed verdicts
    if (!e.verdictPath || !e.cardId) continue; // can't route without these
    if (consumed.has(e.verdictPath)) continue; // already processed (the dedup that prevents double-posting)
    out.push(e);
  }
  return out;
}

/**
 * Derive the single backward-edge target for a state from the board's compiled machine (advisor REJECT
 * routing — the advisor persona never emits `to`, so the conductor derives it). Returns the `to` when
 * EXACTLY one `type:"REJECT"` transition leaves `state`, else undefined (0 or >1 → caller escalates; never
 * guess). @see SKILL.md "REJECT routing".
 * @param {{transitions?: Array<{from:string, type:string, to:string}>}|null|undefined} machine
 * @param {string} state
 * @returns {string|undefined}
 */
export function rejectTargetOf(machine, state) {
  const edges = (machine?.transitions ?? []).filter(
    (t) => t && t.from === state && t.type === "REJECT" && t.to,
  );
  return edges.length === 1 ? edges[0].to : undefined;
}

/**
 * The epic-bounded selector: take up to K cards from the TOP epic's ready cards first (preserves the
 * "finish one epic before the next" focus discipline); cross-epic only if the top epic has fewer than K
 * ready. `cards` MUST already be sorted by (epic priority, card priority, id) — list-ready.mjs emits them
 * in that order; this function never re-sorts. Pure.
 * @param {Array<object>} cards already-sorted dispatch-kind lines
 * @param {number} K max dispatches this pass
 * @param {(card:object)=>number} epicOf root-epic priority of a card
 * @returns {Array<object>} the selected cards (≤K)
 */
export function selectForDispatch(cards, K, epicOf) {
  if (!Array.isArray(cards) || cards.length === 0 || K <= 0) return [];
  const topPriority = epicOf(cards[0]);
  const topEpic = cards.filter((c) => epicOf(c) === topPriority);
  if (topEpic.length >= K) return topEpic.slice(0, K);
  // top epic has <K ready → fill cross-epic up to K (cards are sorted, so this takes top-epic first)
  return cards.slice(0, K);
}

/**
 * How many NEW cards to dispatch this pass. Pure. Combines the per-pass rate limit K, the total-in-flight
 * ceiling maxConcurrent, the count already in-flight, and the circuit-breaker state:
 *   - "CLOSED"    → min(K, maxConcurrent − inFlightCount), floored at 0 (normal fan-out)
 *   - "HALF_OPEN" → at most 1 (single probe after cooldown), still headroom-clamped
 *   - "OPEN"      → 0 (reconcile-only; gateway is shedding load)
 * @param {{K:number, maxConcurrent:number, inFlightCount:number, breakerState:"CLOSED"|"HALF_OPEN"|"OPEN"}} o
 * @returns {number}
 */
export function computeEffectiveK({ K, maxConcurrent, inFlightCount, breakerState }) {
  if (breakerState === "OPEN") return 0;
  const cap = breakerState === "HALF_OPEN" ? 1 : K;
  return Math.max(0, Math.min(cap, maxConcurrent - inFlightCount));
}

/**
 * Advance the 529 circuit breaker one step. Evaluated each pass AFTER reconcile, so `saw529` reflects this
 * pass's reconciled verdicts. Cooldown + half-open semantics (now/breakerUntil epoch ms, cooldownS seconds):
 *   - saw529 (from ANY state)      → OPEN, breakerUntil = now + cooldownS*1000 (trip / re-arm)
 *   - OPEN and now ≥ breakerUntil  → HALF_OPEN (allow one probe next pass)
 *   - HALF_OPEN and !saw529        → CLOSED (probe pass came back clean)
 *   - otherwise                    → unchanged
 * Pure — no clock read, no I/O.
 * @param {{state:"CLOSED"|"HALF_OPEN"|"OPEN", breakerUntil?:number, saw529:boolean, now:number, cooldownS:number}} o
 * @returns {{state:"CLOSED"|"HALF_OPEN"|"OPEN", breakerUntil:number}}
 */
export function advanceBreaker({ state, breakerUntil = 0, saw529, now, cooldownS }) {
  if (saw529) return { state: "OPEN", breakerUntil: now + cooldownS * 1000 };
  if (state === "OPEN" && now >= breakerUntil) return { state: "HALF_OPEN", breakerUntil };
  if (state === "HALF_OPEN") return { state: "CLOSED", breakerUntil };
  return { state, breakerUntil };
}

/**
 * Decide this pass's dispatch budget: reduce the 529 signal from reconcile results, advance the breaker, then
 * compute effectiveK. Pure — composes advanceBreaker + computeEffectiveK; main() supplies the I/O (read/write
 * the breaker state file, count in-flight).
 * @param {{recResults:Array<{error_type?:string}>|undefined, prevBreaker:{state:string,breakerUntil:number},
 *          inFlightCount:number, K:number, maxConcurrent:number, cooldownS:number, now:number}} o
 * @returns {{effectiveK:number, breaker:{state:string,breakerUntil:number}, saw529:boolean}}
 */
export function decideDispatch({ recResults, prevBreaker, inFlightCount, K, maxConcurrent, cooldownS, now }) {
  const saw529 = Array.isArray(recResults) && recResults.some((r) => r?.error_type === "gateway_529");
  const breaker = advanceBreaker({ ...prevBreaker, saw529, now, cooldownS });
  const effectiveK = computeEffectiveK({ K, maxConcurrent, inFlightCount, breakerState: breaker.state });
  return { effectiveK, breaker, saw529 };
}

/**
 * Classify a failed act result as TRANSIENT (the board was degraded — retry next pass) vs DETERMINISTIC
 * (the act itself is invalid — park for a human). The over-parking fix (#65): link-pr/push fire on every
 * dev submission, so a transient board blip must NOT park the card for a human ANSWER; it should just fail
 * the act and let the next pass re-derive + retry (the pre-#64 behavior).
 *
 * The board client (vendor/core.mjs) preserves the real HTTP `status` on the result and maps 403→unauthorized
 * / 409→fenced / 422→bad_act; any other status keeps its `status` but falls through to `bad_act`. A network
 * throw surfaces via makeRun as `{outcome:"error"}` (no JSON on the crashed act's stdout).
 *   Transient (don't park): outcome "error" (client threw / spawn failed), status 429 (rate-limit), any 5xx
 *     (500/502/503/529), or 409 fenced (the card's gen moved on — next pass re-derives).
 *   Deterministic (park): 422 bad_act / 403 unauthorized / any other 4xx — these never self-heal by retrying.
 * A result with no numeric status (and not the "error" envelope) is treated as deterministic — the safe
 * default is to park (matches the pre-#65 escalate-always behavior).
 * @param {{outcome?:string, status?:number|string}|null|undefined} result
 * @returns {boolean} true iff the failure is transient (caller must NOT park)
 */
export function isTransientActFailure(result) {
  if (!result) return true; // no result at all → client crashed before emitting → transient
  if (result.outcome === "error") return true; // makeRun's crash/no-JSON envelope (network throw / spawn fail)
  const s = Number(result.status);
  if (Number.isNaN(s)) return false; // unknown shape → deterministic (safe default: park)
  if (s === 429 || s >= 500) return true; // rate-limit / server error → board degraded
  if (s === 409) return true; // fenced — gen moved on; next pass re-derives, don't park
  return false; // 422 bad_act / 403 unauthorized / other 4xx → deterministic → park
}

/** Detect a board "bounce budget exhausted" 422 on a REJECT (thrash cap → escalate, don't re-loop). */
function isBounceBudget(r) {
  if (r?.outcome !== "gate_blocked") return false;
  if (Array.isArray(r.blocked_by) && r.blocked_by.some((b) => /bounce/i.test(String(b)))) return true;
  return /bounce budget/i.test(r.reason ?? "");
}

// ============================================================================
// routeVerdict — the routing parity contract (SKILL.md step 2/3 → deterministic code)
// ============================================================================

/**
 * Route a parsed verdict to the matching act-script calls. THE parity contract with SKILL.md.
 *
 * Verdict-shape discrimination (no ctx.role lookup needed — the verdict shape identifies the dispatcher):
 *   - advance/reject(with verdict.to)/submitted/decomposed/question/error → worker (stage owner) verdict.
 *   - advice/clean/veto/hold → advisor verdict. reject WITHOUT verdict.to → advisor reject (derive edge).
 *
 * Async reshape: a MOVE that 422s with `blocked_by ⊇ advisor_clear` dispatches the stage's advisor
 * fire-and-forget (reconciled NEXT pass) instead of the old same-pass inline advisor — see the
 * "advisorClear422" return flag.
 *
 * @param {object} opts
 * @param {object|null} opts.verdict  parsed verdict ({status, head?, reason?, to?, summary?, evidence?, children?, spawn?})
 * @param {object} opts.ctx  dispatch context ({id, state, role, to, kind, gen, repo?, branch?, head?, type?})
 * @param {object} opts.lifecycle  board.json lifecycle (lifecycle[state].advisors?.[0]?.role for the 422 case)
 * @param {object} opts.machine     compiled machine (rejectTargetOf for advisor REJECT)
 * @param {function} opts.run       async (script, args) => resultObj; act scripts → JSON; fingerprint → {id}; build-prompt → {path}
 * @param {function} opts.dispatch  (role, cardId, promptFile) => verdictPath (fire-and-forget yarradev-dispatch)
 * @param {function} [opts.getCard] async (id) => card|null (spawn[] dedup pre-check)
 * @param {function} [opts.buildAdvisorPrompt] (ctx, advisorRole) => promptFilePath (the 422 async dispatch)
 * @returns {Promise<{acts: Array<{script,args,result}>, dispatches: Array<{role,cardId,promptFile}>, advisorClear422: boolean, spawnDeferred: number, error?: Error}>}
 */

/**
 * #92: escalation text for a `question` verdict that carries no question. Names the role, stage, and the
 * gen/head it was produced at, so the park a human lands on says WHY it exists — the old fallback was the
 * bare word "question", which blocks the card (ASK → blocked=true, and `not_blocked` is a gate predicate)
 * while giving the human nothing to answer.
 */
export function malformedQuestionReason(ctx = {}, verdict = {}) {
  const where = `${ctx.role ?? "unknown-role"}@${ctx.state ?? "unknown-state"}`;
  const at = [ctx.gen != null ? `gen ${ctx.gen}` : null, verdict.head ?? ctx.head ? `head ${verdict.head ?? ctx.head}` : null]
    .filter(Boolean)
    .join(", ");
  return `${where} returned status:"question" with no reason or question field (malformed verdict${at ? ` at ${at}` : ""})`;
}

export async function routeVerdict({
  verdict,
  ctx,
  lifecycle,
  machine,
  run,
  dispatch,
  getCard = async () => null,
  buildAdvisorPrompt = (c, role) => `/tmp/yarradev-prompt-${c.id}-${role}.txt`,
}) {
  const acts = [];
  const dispatches = [];
  let advisorClear422 = false;
  let spawnDeferred = 0;
  let actFailed = null;

  /** Call an act script via the injected `run` and record the invocation (the parity record assertions read). */
  const call = async (script, args) => {
    const result = await run(script, args);
    acts.push({ script, args, result });
    return result;
  };

  try {
    if (!verdict || typeof verdict !== "object") {
      return { acts, dispatches, advisorClear422, spawnDeferred };
    }
    const id = ctx.id;
    const gen = ctx.gen;
    const status = verdict.status;

    /** Load-bearing act failed → surface (act_failed) AND park (escalate). Uniform across branches (#58/#59/#60).
     * Defined here (not above the try) because it closes over `id`, which is scoped to this try block. */
    const failAct = async (script, result, reason) => {
      actFailed = { script, result: result ?? null };
      await call("escalate.mjs", [id, reason]);
    };

    /** Transient-aware variant (#65): set act_failed always, but PARK (escalate) only when the failure is
     * DETERMINISTIC. A transient board blip (429/5xx/network/409-fenced) is left to retry next pass instead
     * of parking the card for a human. Used by the highest-frequency reconcile-time acts (link-pr/push/reject).
     * NOTE: advance/decompose intentionally keep failAct (park-always) — a partial decompose must park to
     * avoid re-decompose duplicates regardless of failure class. */
    const failActMaybePark = async (script, result, reason) => {
      actFailed = { script, result: result ?? null };
      if (!isTransientActFailure(result)) await call("escalate.mjs", [id, reason]);
    };

    // ---- worker advance ------------------------------------------------------
    if (status === "advance") {
      const mv = await call("move.mjs", [id, gen, ctx.to, ctx.role]);
      if (mv && mv.ok) {
        // Persist the stage's rationale onto notes[] (GH #18). Note shape: "[<role>→<to>] <summary> <evidence>".
        if (verdict.summary || verdict.evidence) {
          const parts = [verdict.summary, verdict.evidence].filter((x) => x != null && x !== "").join(" ");
          await call("note.mjs", [id, `[${ctx.role}→${ctx.to}] ${parts}`]);
        }
      } else if (
        mv &&
        mv.outcome === "gate_blocked" &&
        Array.isArray(mv.blocked_by) &&
        mv.blocked_by.includes("advisor_clear")
      ) {
        // ASYNC RESHAPE: dispatch the stage's advisor fire-and-forget (reconciled next pass); do NOT retry
        // the MOVE this pass. advisorRole derived from lifecycle — never hardcoded.
        const advisorRole = lifecycle?.[ctx.state]?.advisors?.[0]?.role;
        if (advisorRole) {
          const promptFile = await buildAdvisorPrompt(ctx, advisorRole);
          await dispatch(advisorRole, id, promptFile);
          dispatches.push({ role: advisorRole, cardId: id, promptFile });
          advisorClear422 = true;
        }
        // no advisor configured → inert (a stage with no advisor never produces advisor_clear in practice)
      }
      // any other 422/409 → ordinary failure path (caller CLEAR_LEASEs; decide re-derives next pass)
      // GH #54: an unhandled MOVE failure (not ok, not the advisor_clear reshape) must be surfaced, not
      // silently reported as "routed".
      if (!(mv && mv.ok) && !advisorClear422) {
        await failAct("move.mjs", mv, `advance act failed (${ctx.state}→${ctx.to}): ${mv?.reason ?? mv?.outcome ?? "no detail"}`);
      }
      return { acts, dispatches, advisorClear422, spawnDeferred, actFailed };
    }

    // ---- reject (worker carries `to`; advisor omits it → conductor derives) ---
    if (status === "reject") {
      if (verdict.to != null) {
        // worker reject — backward edge from the verdict, posted under the stage owner.
        const r = await call("reject.mjs", [id, gen, verdict.to, ctx.role]);
        if (r && !r.ok) {
          if (isBounceBudget(r)) await call("escalate.mjs", [id, `bounce budget: ${ctx.state}→${verdict.to}`]);
          else await failActMaybePark("reject.mjs", r, `reject act failed (${ctx.state}→${verdict.to}): ${r?.reason ?? r?.outcome ?? "no detail"}`); // #65: transient → retry, not park
        }
      } else {
        // advisor reject — derive the single backward edge from the compiled machine.
        const derivedTo = rejectTargetOf(machine, ctx.state);
        if (derivedTo != null) {
          const r = await call("reject.mjs", [id, gen, derivedTo, ctx.role]); // under the ADVISOR's role, not the owner
          if (r && !r.ok) {
            if (isBounceBudget(r)) await call("escalate.mjs", [id, `bounce budget: ${ctx.state}→${derivedTo}`]);
            else await failActMaybePark("reject.mjs", r, `advisor reject act failed (${ctx.state}→${derivedTo}): ${r?.reason ?? r?.outcome ?? "no detail"}`); // #65: transient → retry, not park
          }
        } else {
          // 0 or >1 REJECT edges → ambiguous; never guess.
          await call("escalate.mjs", [id, `reject edge ambiguous for state ${ctx.state}`]);
        }
      }
      return { acts, dispatches, advisorClear422, spawnDeferred, actFailed };
    }

    // ---- mechanical submitted (LINK_PR first submission / PUSH respawn fix) ---
    if (status === "submitted") {
      const ev = verdict.evidence ?? {};
      const { repo, pr_number: pr, head } = ev;
      const submit = ctx.kind === "respawn"
        ? await call("push.mjs", [id, gen, repo, pr, head]) // pr_link already exists → re-point head
        : await call("link-pr.mjs", [id, gen, repo, pr, head]); // first submission (work/reclaim) → create pr_link
      if (!(submit && submit.ok)) {
        // #65: a transient board blip (429/5xx/network) must NOT park — link-pr/push fire on every dev
        // submission; only a deterministic 422 bad_act parks. Transient → act_failed + retry next pass.
        await failActMaybePark(ctx.kind === "respawn" ? "push.mjs" : "link-pr.mjs", submit, `submit act failed for ${id}: ${submit?.reason ?? submit?.outcome ?? "no detail"}`);
        // A failed submit never created/updated the pr_link, so reattach-ci (which re-fires the CI webhook
        // against that row) is pointless — skip it (#65 tidy-up). Next pass re-derives + retries the submit.
        return { acts, dispatches, advisorClear422, spawnDeferred, actFailed };
      }
      // Recover stranded CI (GH #21) — CI completion often lands before LINK_PR creates the row.
      await call("reattach-ci.mjs", [id, repo, pr, head]); // best-effort CI recovery — never escalate
      return { acts, dispatches, advisorClear422, spawnDeferred, actFailed };
    }

    // ---- analyst decomposed (fan an epic out into child story cards) ----------
    if (status === "decomposed") {
      const children = Array.isArray(verdict.children) ? verdict.children : [];
      if (children.length === 0) {
        // A zero-length decomposition is invalid — treat as a question (mirrors reduce()'s escalate-on-0).
        await call("escalate.mjs", [id, "decomposed with no children"]);
        return { acts, dispatches, advisorClear422, spawnDeferred };
      }
      let allCreated = true;
      for (const child of children) {
        const args = [child.title, "--parent", id];
        if (Array.isArray(child.depends_on) && child.depends_on.length) {
          args.push("--depends-on", child.depends_on.join(","));
        }
        const r = await call("create.mjs", args);
        if (!r || !r.ok) {
          allCreated = false;
          // GH #54/#60: partial decomposition surfaced AND parked (avoid re-decompose duplicates on retry).
          await failAct("create.mjs", r, "decompose CREATE failed mid-loop (partial children) — parking to avoid re-decompose duplicates");
          break; // CREATE failure → stop issuing further CREATEs; next pass re-dispatches the analyst.
        }
      }
      if (allCreated) {
        const mvr = await call("move.mjs", [id, gen, ctx.to, ctx.role]); // advance the epic to the barrier stage
        if (!(mvr && mvr.ok)) {
          // GH #54: children were minted but the epic can't reach the barrier stage → inconsistent half-state.
          // Surface AND escalate (loud board signal), not a silent retry.
          await failAct("move.mjs", mvr, "decomposed: children created but barrier advance failed");
        }
      }
      return { acts, dispatches, advisorClear422, spawnDeferred, actFailed };
    }

    // ---- question → escalate (park for a human) ------------------------------
    if (status === "question") {
      // #92: the old fallback was the bare string "question", which minted an escalation with no content.
      // ASK sets blocked=true and `not_blocked` is a gate predicate, so the card was held by a question that
      // asked nothing — unanswerable on its merits and clearable only by fiat. (Live: 9a120b8d on
      // yarrasys:yarradev sat at spec behind a complete designer plan with not_blocked its ONLY failing
      // predicate.) A reasonless `question` is a MISBEHAVING agent, so we still park it — declining to park
      // would just re-dispatch the card next pass and risk a dispatch→question→re-dispatch livelock — but
      // the text now names what happened so the human can clear it on an informed basis.
      const given = [verdict.reason, verdict.question].find((x) => typeof x === "string" && x !== "");
      const reason = given ?? malformedQuestionReason(ctx, verdict);
      await call("escalate.mjs", [id, reason]);
      return { acts, dispatches, advisorClear422, spawnDeferred };
    }

    // ---- error / unknown → post nothing (log; retry next pass) ---------------
    if (status === "error") {
      return { acts, dispatches, advisorClear422, spawnDeferred };
    }

    // ---- advisor advice/clean (+ spawn[] sub-clause: reviewer-raised bugs) ---
    if (status === "advice" || status === "clean") {
      const role = ctx.role; // THIS pass's dispatched advisor role (NOT default security-advisor)
      const adviceArgs = [id, verdict.head];
      if (verdict.reason != null && verdict.reason !== "") adviceArgs.push(verdict.reason);
      adviceArgs.push("--role", role);
      const adv = await call("advice.mjs", adviceArgs); // records a CLEAN review → advisor_clear goes non-vacuous
      // GH #85: this act is THE thing that clears advisor_clear — an unchecked failure here was silently
      // reported as "routed", the verdict was consumed, and the card stalled at this stage forever with a
      // clean review that never landed. Surface it (and park only on a deterministic failure, per #65).
      if (!(adv && adv.ok)) {
        await failActMaybePark("advice.mjs", adv, `advice act failed for ${id} (${role}@${ctx.state ?? "?"}): ${adv?.reason ?? adv?.outcome ?? "no detail"}`);
        // The clean review never landed → spawn[] bug-filing is downstream bookkeeping for a review the
        // board doesn't have. Skip it; the retry (or the human, on a park) re-runs the whole branch.
        return { acts, dispatches, advisorClear422, spawnDeferred, actFailed };
      }

      const spawn = Array.isArray(verdict.spawn) ? verdict.spawn : [];
      const CAP = 20; // mirrors reduce()'s spawn cap
      const limited = spawn.slice(0, CAP);
      spawnDeferred = Math.max(0, spawn.length - CAP);
      for (const entry of limited) {
        // 1. Compute the deterministic bug id (the conductor computes the fingerprint, never the LLM).
        const fpRes = await call("fingerprint.mjs", [ctx.repo, entry.file, entry.summary]);
        const bugId = fpRes?.id;
        if (!bugId) break;
        // 2. Dedup pre-check (idempotent on both CREATE and NOTE) — read notes[] to tell if the repro landed.
        const existing = await getCard(bugId);
        const notes = Array.isArray(existing?.notes) ? existing.notes : null;
        if (existing && notes && notes.length > 0) continue; // fully filed → skip
        if (existing) {
          // Card exists but NOTE never landed (empty notes). Retry the NOTE alone — never re-CREATE.
          if (entry.note) {
            const nr = await call("note.mjs", [bugId, entry.note]);
            if (!nr || !nr.ok) break; // NOTE failure → stop further spawn entries this pass
          }
          continue;
        }
        // 3. Absent → CREATE under the ORCHESTRATOR identity (role-agnostic primitive), then NOTE the repro.
        const createArgs = [
          entry.title,
          "--id",
          bugId,
          "--type",
          "bug",
          "--state",
          "dev",
          "--parent",
          id,
          "--role",
          "orchestrator",
        ];
        const cr = await call("create.mjs", createArgs);
        if (!cr || !cr.ok) break; // CREATE failure → stop further spawn entries this pass
        if (entry.note) {
          const nr = await call("note.mjs", [bugId, entry.note]);
          if (!nr || !nr.ok) break;
        }
      }
      return { acts, dispatches, advisorClear422, spawnDeferred, actFailed };
    }

    // ---- advisor veto/hold (security-advisor's binding verdicts) -------------
    if (status === "veto" || status === "hold") {
      const script = status === "veto" ? "veto.mjs" : "hold.mjs";
      // veto.mjs/hold.mjs hardcode the security-advisor identity (the only advisor with veto/hold authority);
      // no --role flag. Args: <id> <head> [reason...].
      const args = [id, verdict.head];
      if (verdict.reason != null && verdict.reason !== "") args.push(verdict.reason);
      const bind = await call(script, args);
      // GH #85: a dropped VETO/HOLD is strictly worse than a dropped ADVICE — the card advances past a
      // blocking verdict. Same surface-and-maybe-park contract as advice.
      if (!(bind && bind.ok)) {
        await failActMaybePark(script, bind, `${status} act failed for ${id}: ${bind?.reason ?? bind?.outcome ?? "no detail"}`);
      }
      return { acts, dispatches, advisorClear422, spawnDeferred, actFailed };
    }

    // unknown status → no-op (log; let the next pass re-derive)
    return { acts, dispatches, advisorClear422, spawnDeferred };
  } catch (error) {
    // Best-effort: a thrown error in routing is surfaced (not thrown) so the caller's per-card loop survives.
    return { acts, dispatches, advisorClear422, spawnDeferred, error };
  }
}

// ============================================================================
// dispatchNew — bounded-concurrency fan-out (spec §Concurrency)
// ============================================================================

/**
 * Dispatch up to K new concurrent cards (work/respawn/reclaim). For each selected card: CLAIM → build-prompt
 * → fire-and-forget `yarradev-dispatch` → record a dispatch-context entry (so reconcile can recover the
 * kind/to/state/role next pass without re-deriving). Best-effort: one card's failure never aborts the pass.
 * @param {object} opts
 * @param {object} [opts.cfg] board.json (loadConfig() result) — sources role-specific dispatch extras
 *   (currently: the releaser's `deployCmd`/`smokeCmd`, from `cfg.deploy`/`cfg.smoke`). Optional so existing
 *   callers/tests that don't need extras keep working unchanged.
 * @param {function} [opts.writeExtras] (path, content) => void — injected for testability (default fs.writeFileSync).
 * @returns {Promise<{dispatched: Array, skipped: Array}>}
 */
export async function dispatchNew({
  cards,
  K,
  epicOf,
  run,
  dispatch,
  writeContext,
  ttlS = 1800,
  cfg = {},
  writeExtras = (path, content) => writeFileSync(path, content),
}) {
  const dispatched = [];
  const skipped = [];
  const selected = selectForDispatch(cards, K, epicOf);
  for (const card of selected) {
    try {
      // CLAIM (respawn carries --respawn → counts toward transition_budget, v1 parity).
      const claimArgs = [card.id, card.role, ttlS];
      if (card.kind === "respawn") claimArgs.push("--respawn");
      const claim = await run("claim.mjs", claimArgs);
      if (!claim || !claim.ok) {
        // 409 fenced (already leased) or any other claim failure → skip this card (K slot still consumed).
        skipped.push({
          cardId: card.id,
          reason: `claim ${claim?.status ?? "failed"}: ${claim?.reason ?? claim?.outcome ?? ""}`.trim(),
        });
        continue;
      }
      // Build the worker dispatch prompt (notes[] forwarded — GH #18).
      const buildPromptArgs = [card.role, card.id, "--to", card.to];
      // Releaser needs deployCmd/smokeCmd (board.json's deploy.*/smoke.*) to actually deploy — without this
      // it always dispatched blind and escalated "no deploy command configured" regardless of board.json,
      // no matter how correctly deploy.staging was set. Only wire it when a command is actually configured;
      // an unconfigured leg falls through to the releaser's own fail-closed "question" (never guess).
      const deployCmd = card.role === "releaser" ? (card.to === "prod" ? cfg.deploy?.prod : cfg.deploy?.staging) : undefined;
      if (deployCmd) {
        const smokeCmd = card.to === "prod" ? cfg.smoke?.prod : cfg.smoke?.staging;
        const lines = [`deployCmd: ${deployCmd}`];
        if (smokeCmd) lines.push(`smokeCmd: ${smokeCmd}`);
        const extrasPath = `/tmp/yarradev-extras-${card.id}.txt`;
        writeExtras(extrasPath, lines.join("\n") + "\n");
        buildPromptArgs.push("--extras-file", extrasPath);
      }
      const prompt = await run("build-prompt.mjs", buildPromptArgs);
      const promptFile = prompt?.path;
      if (!promptFile) {
        skipped.push({ cardId: card.id, reason: "build-prompt returned no path" });
        continue;
      }
      // Fire-and-forget dispatch (NEVER dispatch-and-wait.mjs — that blocks). Returns the verdictPath
      // immediately while claude -p is still running; the background run.sh appends `done` when it exits.
      const verdictPath = await dispatch(card.role, card.id, promptFile);
      // Record the dispatch context so next pass's reconcile can route the verdict (kind is the load-bearing
      // field — submitted→link-pr vs push). Best-effort: a write failure doesn't undo the dispatch.
      const ctx = {
        id: card.id,
        kind: card.kind,
        to: card.to,
        state: card.state,
        role: card.role,
        gen: claim.gen,
      };
      try {
        writeContext(verdictPath, ctx);
      } catch (e) {
        process.stderr.write(`[pass] writeContext ${verdictPath} failed: ${e?.message ?? e} (non-fatal)\n`);
      }
      dispatched.push({ role: card.role, cardId: card.id, to: card.to, state: card.state, promptFile, verdictPath });
    } catch (e) {
      // best-effort: a thrown error in one card's dispatch is caught + logged; the rest proceed.
      skipped.push({ cardId: card.id, reason: e?.message ?? String(e) });
    }
  }
  return { dispatched, skipped };
}

// ============================================================================
// reconcileVerdicts — drive each unconsumed `done` verdict through routeVerdict
// ============================================================================

/** #81: advisor verdicts whose board acts take no lease/gen (advice/clean → advice.mjs, veto/hold →
 * veto/hold.mjs). reconcileVerdicts routes these WITHOUT re-CLAIMing — a re-CLAIM would 409 on the card's
 * active lease (the test-stage owner churning it) and the verdict would be dropped as "stale", stranding
 * advisor_clear forever (the clean-card livelock). Their routeVerdict branches read only id / verdict.head /
 * verdict.reason / ctx.role — never ctx.gen. */
const GEN_EXEMPT_STATUSES = new Set(["advice", "clean", "veto", "hold"]);

/**
 * #87: is `role` an advisor that owns no stage in this lifecycle? Such a role can only ever have been
 * reshape-dispatched (routeVerdict's advance branch fires a bare `dispatch()` — no CLAIM, no writeContext),
 * so with NO recorded dispatch context it holds no lease and has no gen to recover. Re-CLAIMing there would
 * grant a lease to a leaseless-by-design advisor AND bump current_gen, invalidating the stage owner's
 * in-flight lease — the same 409 collision class #81 set out to avoid.
 *
 * Deliberately narrow on BOTH axes so the worker recovery path (#27) is untouched:
 *   - a role that owns any stage is a worker, even if it also advises elsewhere → never carved out;
 *   - the carve-out only applies when the dispatch context is ABSENT. An advisor that WAS dispatched as
 *     {kind:"work"} by decide() (advisor_clear failing) does hold a real lease recorded in the ledger
 *     (#85) — that entry keeps the normal gen/lease handling, including its CLEAR_LEASE.
 */
export function isLeaselessAdvisorRole(role, lifecycle) {
  if (!role || !lifecycle || typeof lifecycle !== "object") return false;
  let isAdvisor = false;
  for (const stage of Object.values(lifecycle)) {
    if (stage?.owner === role) return false; // owns a stage → a worker; its CLAIM is legitimate
    if (Array.isArray(stage?.advisors) && stage.advisors.some((a) => a?.role === role)) isAdvisor = true;
  }
  return isAdvisor;
}

/**
 * For each unconsumed `done` manifest entry: read the verdict, re-CLAIM (fresh gen — recovers verdicts that
 * landed past lease-TTL), route via routeVerdict, CLEAR_LEASE, mark consumed. Best-effort throughout: a
 * single card's failure is caught + logged and does NOT abort the pass.
 *
 * Consumption rule: an entry is marked consumed once we've PROCESSED it (read + attempted routing), including
 * stale-CLAIM (409 → card moved on; the verdict is obsolete), no-parse verdicts, and even routing crashes —
 * re-dispatching the card (if still actionable) happens naturally via the next pass's dispatchNew, bounded by
 * the in-flight filter + transition budgets. The only way an entry is NOT consumed is if it isn't `done` yet.
 *
 * All I/O deps are injected (readVerdict / appendConsumed / readContext) so the routing is unit-testable
 * without touching the filesystem; the helpers (nextUnconsumedDone / parseLastVerdict) have their own tests.
 * @param {object} opts
 * @returns {Promise<Array>} per-entry results
 */
export async function reconcileVerdicts({
  manifestContent,
  consumedContent,
  contextContent,
  lifecycle,
  machine,
  run,
  dispatch,
  getCard,
  buildAdvisorPrompt,
  readVerdict,
  appendConsumed,
  readContext,
  ttlS = 1800,
  logger = (msg) => process.stderr.write(msg + "\n"),
}) {
  const done = nextUnconsumedDone(manifestContent, consumedContent);
  const results = [];
  for (const entry of done) {
    const { cardId, verdictPath, role } = entry;
    try {
      const verdictText = await readVerdict(verdictPath);
      const verdict = parseLastVerdict(verdictText);
      const recorded = await readContext(verdictPath);

      // #81: advice/clean/veto/hold are GEN-EXEMPT advisor acts — route them WITHOUT resolving a gen. A
      // re-CLAIM here 409-collides with the card's ACTIVE lease (the test-stage owner) and the verdict would
      // be dropped as "stale" (the clean-card livelock: no clean ADVICE lands → advisor_clear never clears →
      // tester+reviewer re-dispatch forever). The advisor is fire-and-forget reshape-dispatched and holds no
      // lease of its own, so there is also no lease to CLEAR here. routeVerdict's advice/veto/hold branches
      // read only id / verdict.head / verdict.reason / ctx.role — never ctx.gen.
      if (verdict && GEN_EXEMPT_STATUSES.has(verdict.status)) {
        const ctx = { id: cardId, role, ...(recorded ?? {}) };
        const r = await routeVerdict({ verdict, ctx, lifecycle, machine, run, dispatch, getCard, buildAdvisorPrompt });

        // #85: the advisor is NOT always leaseless. #81 assumed the fire-and-forget reshape path was the
        // only way an advisor runs, but decide() also returns {kind:"work", role: advisorRoleFor(state)}
        // when advisor_clear is failing (vendor/core.mjs) — and dispatchNew CLAIMs that, role-blind. So an
        // advisor CAN hold a real lease, recorded in the dispatch-context ledger. Release it iff it's still
        // ours: recorded.gen present AND still the card's current_gen. Skipping this left the lease dangling
        // for the full claimTtlS, and decide() noops on `leased` → the card silently stalls at the stage.
        // The #81 invariant is preserved: with no recorded gen (the reshape path) we hold nothing and clear
        // nothing, and we never re-CLAIM either way.
        let heldGen = null;
        if (recorded?.gen != null) {
          const leaseCard = await getCard(cardId);
          if (leaseCard && leaseCard.current_gen === recorded.gen) heldGen = recorded.gen;
        }

        // #85: a TRANSIENT act failure must not burn the verdict. Consuming it here is what made the
        // advisor's completed work unrecoverable — the manifest entry was the only remaining copy. Leave it
        // unconsumed (and the lease held, so decide() can't race a second advisor dispatch) and the next
        // pass re-posts it; ADVICE/VETO/HOLD are idempotent at a given head, so re-posting is safe.
        if (r.actFailed && isTransientActFailure(r.actFailed.result)) {
          logger(`[pass] reconcile ${verdictPath}: advisor act ${r.actFailed.script} failed transiently (${r.actFailed.result?.reason ?? r.actFailed.result?.outcome ?? "no detail"}) — retrying next pass, verdict NOT consumed`);
          results.push({
            verdictPath,
            cardId,
            outcome: "act_failed",
            retry: true,
            advisorClear422: r.advisorClear422,
            state: ctx.state ?? null,
            to: ctx.to ?? null,
            actFailed: r.actFailed,
          });
          continue;
        }

        if (heldGen != null) await run("clear-lease.mjs", [cardId, heldGen]);
        await appendConsumed(verdictPath);
        if (r.actFailed) {
          logger(`[pass] reconcile ${verdictPath}: advisor act ${r.actFailed.script} FAILED (${r.actFailed.result?.reason ?? r.actFailed.result?.outcome ?? "no detail"}) — verdict NOT posted`);
        }
        results.push({
          verdictPath,
          cardId,
          outcome: r.error ? "error" : r.actFailed ? "act_failed" : "routed",
          advisorClear422: r.advisorClear422,
          state: ctx.state ?? null,
          to: ctx.to ?? null,
          ...(r.actFailed ? { actFailed: r.actFailed } : {}),
          ...(r.error ? { error: r.error } : {}),
        });
        continue;
      }

      // Determine the gen to post under (#37). The dispatch-context ledger recorded the original CLAIM gen;
      // if it's STILL current (the lease is active — lease-TTL hadn't bumped it), use it directly. Re-CLAIMing
      // now would 409 on the active lease and leave the card stuck leased for up to claimTtlS. Only re-CLAIM
      // when the original gen is stale (lease expired → bumped) or absent — that's the #27 recovery path.
      let gen;
      // #87: did WE take (or inherit) a lease on this card? Governs the CLEAR_LEASE calls below — a
      // reshape-dispatched advisor holds none, and clearing one it never took is a gen-required act that
      // can only 409 (or, worse, release someone else's).
      let holdsLease = true;
      let leaselessState = null;
      const originalGen = recorded?.gen;
      if (originalGen != null) {
        const leaseCard = await getCard(cardId);
        if (leaseCard && leaseCard.current_gen === originalGen) {
          gen = originalGen; // lease active, gen current → use it (no re-CLAIM, no spurious 409)
        }
      }
      if (gen == null && recorded == null && isLeaselessAdvisorRole(role, lifecycle)) {
        // #87: a reshape-dispatched advisor returning a NON-gen-exempt status (question/reject/advance/
        // error/unparseable). It holds no lease, so there is no gen to recover — READ the card's gen
        // instead of CLAIMing for it. Board-side, gen-required acts fence on `gen === current_gen` with no
        // lease-ownership check (workers/board/src/storage.ts), which is the same trick applySyncAction's
        // `promote` already relies on. So an advisor REJECT still lands at the observed gen, while ESCALATE
        // (question) and the no-act statuses never needed one. No CLAIM → no lease, no gen bump, no
        // collision with the stage owner.
        const cur = await getCard(cardId);
        gen = cur?.current_gen ?? null;
        holdsLease = false;
        // The reshape path also recorded no state, and routeVerdict's advisor-reject branch derives the
        // backward edge from it (rejectTargetOf(machine, ctx.state)). Take it from the card we just read —
        // without it the derive fails and a legitimate advisor reject escalates as "edge ambiguous".
        if (cur?.state != null) leaselessState = cur.state;
        logger(`[pass] reconcile ${verdictPath}: leaseless advisor '${role}' (no dispatch context) — routing at read gen ${gen ?? "unknown"}, no CLAIM`);
      }
      if (gen == null && holdsLease) {
        const claim = await run("claim.mjs", [cardId, role, ttlS]);
        if (!claim || !claim.ok) {
          const reason =
            claim?.status === 409 ? "stale verdict (card moved on)" : `claim ${claim?.status ?? "failed"}`;
          logger(`[pass] reconcile ${verdictPath}: ${reason}; consuming`);
          await appendConsumed(verdictPath);
          results.push({ verdictPath, cardId, outcome: "skipped", reason });
          continue;
        }
        gen = claim.gen;
      }

      if (verdict == null) {
        // No fenced verdict block. Distinguish a dispatcher error envelope (gateway 529 / crash / empty —
        // GH #44) from a genuine no-verdict, so an inference-gateway outage doesn't masquerade as a card
        // stall. Either way: post nothing, clear the lease, consume (the card re-dispatches next pass).
        const err = parseErrorEnvelope(verdictText);
        if (err) {
          logger(`[pass] reconcile ${verdictPath}: dispatch error (${err.error_type})${err.detail ? ` — ${String(err.detail).slice(0, 120)}` : ""}; consuming (surfaced, not a card stall)`);
        } else {
          logger(`[pass] reconcile ${verdictPath}: no parseable verdict block; consuming`);
        }
        if (holdsLease) await run("clear-lease.mjs", [cardId, gen]); // #87: nothing to clear when leaseless
        await appendConsumed(verdictPath);
        results.push({ verdictPath, cardId, outcome: err ? "dispatch_error" : "no-parse", ...(err ? { error_type: err.error_type } : {}) });
        continue;
      }

      const ctx = {
        id: cardId,
        role,
        gen,
        ...(leaselessState != null ? { state: leaselessState } : {}), // #87: recovered from the card read
        ...(recorded ?? {}),
      };

      const r = await routeVerdict({
        verdict,
        ctx,
        lifecycle,
        machine,
        run,
        dispatch,
        getCard,
        buildAdvisorPrompt,
      });

      // CLEAR_LEASE — in every branch that HOLDS one (the caller owns this; routeVerdict never clears).
      // #87: a reshape-dispatched advisor took no lease, so there is nothing to release here.
      if (holdsLease) await run("clear-lease.mjs", [cardId, gen]);
      await appendConsumed(verdictPath);
      if (r.actFailed) {
        logger(`[pass] reconcile ${verdictPath}: act ${r.actFailed.script} FAILED (${r.actFailed.result?.reason ?? r.actFailed.result?.outcome ?? "no detail"}) — card NOT advanced`);
      }
      results.push({
        verdictPath,
        cardId,
        outcome: r.error ? "error" : r.actFailed ? "act_failed" : "routed",
        advisorClear422: r.advisorClear422,
        state: ctx.state ?? null,
        to: ctx.to ?? null,
        ...(r.actFailed ? { actFailed: r.actFailed } : {}),
        ...(r.error ? { error: r.error } : {}),
      });
    } catch (e) {
      // Best-effort: log + consume so a bad entry never stalls the pass (the card re-dispatches next pass
      // if still actionable, bounded by the in-flight filter + transition budgets).
      logger(`[pass] reconcile ${verdictPath} failed: ${e?.message ?? e}; consuming`);
      try {
        await appendConsumed(verdictPath);
      } catch {
        /* appendConsumed failure is logged by the outer caller's audit, not here */
      }
      results.push({ verdictPath, cardId, outcome: "error", error: e });
    }
  }
  return results;
}

// ============================================================================
// applySyncAction — the non-dispatch kinds (advance/promote/escalate), posted directly with no subagent
// ============================================================================

/**
 * Route a non-dispatch list-ready action synchronously (no CLAIM-and-dispatch: advance is a mechanical MOVE,
 * promote is a CLAIM-free MOVE at the current gen, escalate parks for a human). These do NOT count against
 * K (K bounds concurrent SUBAGENT dispatches only). Minimal V1 — the autonomous-release nuance and the
 * epic-done signal are deferred to the SKILL.md wiring task.
 * @returns {Promise<{acts: Array, outcome: string, error?: Error}>}
 */
export async function applySyncAction(action, { run, ttlS = 1800, card = null, signalEpicDone = null } = {}) {
  const acts = [];
  const note = (reason) => { acts.push({ note: reason }); };
  const call = async (script, args) => {
    const result = await run(script, args);
    acts.push({ script, args, result });
    return result;
  };
  try {
    if (action.kind === "advance") {
      const claim = await call("claim.mjs", [action.id, action.role, ttlS]);
      if (!claim?.ok) return { acts, outcome: "claim-failed" };
      await call("move.mjs", [action.id, claim.gen, action.to, action.role]);
      await call("clear-lease.mjs", [action.id, claim.gen]);
    } else if (action.kind === "promote") {
      // MOVE at the card's CURRENT gen (no CLAIM — a bump would invalidate the gen-stamped GO / barrier
      // facts). NOTE: autonomous release.mjs (the done→staging human-gate) is DEFERRED — staging→prod stays
      // human-gated in pass.mjs for now (the safe default); port release.mjs + prod-rollout later.
      const args = [action.id, action.to];
      if (action.role) args.push(action.role); // barrier's promoteAs (e.g. analyst); omit → releaser default
      const res = await call("promote.mjs", args);
      const bb = Array.isArray(res?.blocked_by) ? res.blocked_by : [];
      if (!res?.ok && res?.status === 422) {
        if (bb.includes("human_go")) note("awaiting human GO (a byKind:human identity runs human-go.mjs)");
        else if (bb.includes("all_children_terminal")) note("epic barrier: a child regressed after the snapshot — next pass re-derives");
        else note(`promote 422 gate_blocked: [${bb.join(",")}] — next pass re-derives`);
      }
      // Epic completion: an epic barrier crossed into epic_done → write the signal so yarradev-loop restarts
      // with clean context (mirrors SKILL.md's /tmp/yarradev-epic-done + /exit; pass.mjs is one pass, so it
      // writes the file and exits 0 — the wrapper does the restart).
      if (res?.ok && card?.type === "epic" && action.to === "epic_done" && typeof signalEpicDone === "function") {
        signalEpicDone({ epicId: action.id, title: card?.title ?? "", storyCount: card?.children_total ?? 0 });
        note("epic_done signal written");
      }
    } else if (action.kind === "escalate") {
      await call("escalate.mjs", [action.id, action.reason ?? "escalated"]);
    }
    return { acts, outcome: "ok" };
  } catch (error) {
    return { acts, outcome: "error", error };
  }
}

// ============================================================================
// Real (production) dep factories — spawnSync-based; used only by the CLI body
// ============================================================================

/** Parse the last JSON-parseable line of an act script's stdout (emit() writes exactly one JSON line). */
function parseJsonOut(stdout) {
  if (!stdout) return null;
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    try {
      return JSON.parse(t);
    } catch {
      /* keep scanning — a log line mixed in shouldn't break the parse */
    }
  }
  return null;
}

/**
 * Build the real `run(script, args)`: spawnSync the sibling act script, return its parsed result.
 * fingerprint.mjs / build-prompt.mjs print raw text (not JSON) → wrapped into {id} / {path}.
 */
export function makeRun(scriptsDir = SCRIPTS_DIR) {
  return async (script, args) => {
    const r = spawnSync("node", [join(scriptsDir, script), ...(args ?? [])], { encoding: "utf8" });
    if (r.error) {
      throw new Error(`${script} failed to spawn: ${r.error.message}`);
    }
    const stdout = r.stdout ?? "";
    if (script === "fingerprint.mjs") return { id: stdout.trim(), ok: true };
    if (script === "build-prompt.mjs") return { path: stdout.trim(), ok: r.status === 0 };
    const parsed = parseJsonOut(stdout);
    if (parsed) return parsed;
    return {
      ok: false,
      status: r.status,
      outcome: "error",
      reason: (r.stderr ?? "").trim() || `unexpected ${script} output`,
    };
  };
}

/** Strip YDB_TOKEN* from the env handed to a dispatched subagent (defense-in-depth, GH #25). */
function sanitizeEnv(env) {
  const clean = { ...env };
  for (const k of Object.keys(clean)) {
    if (/^YDB_TOKEN/i.test(k)) delete clean[k];
  }
  return clean;
}

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

/**
 * Build the real fire-and-forget `dispatch(role, cardId, promptFile)`. Precedence (highest → lowest):
 *   1. toolPath                      — cfg.runtime.dispatchTool (explicit per-project override)
 *   2. YARRADEV_DISPATCH             — legacy external binary (e.g. ~/work/tools/yarradev-dispatch)
 *   3. the plugin's own dispatch.mjs — the PORTABLE default (GH #43), invoked via `node` (no shebang dep)
 *
 * Returns the verdictPath (stdout) on success; throws on non-zero exit / no-path. The contract the
 * conductor depends on is unchanged.
 *
 * `mode` (GH #51): "external" (default) spawns and blocks as above. "native" spawns dispatch.mjs with
 * YARRADEV_DISPATCH_MODE=native, which emits a dispatch-request JSON line instead of running claude -p;
 * that line is re-emitted to pass.mjs's own stdout so the host conductor sees it and fulfills it via its
 * own Agent tool, and the parsed verdictPath is returned (unchanged dispatchNew contract).
 */
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

/** Build the real advisor-prompt writer (the 422 async-dispatch path). Sources `head` from the card's linked
 * PR (GH #55 — ctx is empty for tester-owned stages); the advisor self-discovers its branch by cardId. */
export function makeBuildAdvisorPrompt(lifecycle, doName, getCard) {
  return async (ctx, advisorRole) => {
    const advisor = lifecycle?.[ctx.state]?.advisors?.find((a) => a?.role === advisorRole);
    const watchPaths = Array.isArray(advisor?.watch_paths) ? advisor.watch_paths : [];
    let head = ctx.head ?? "";
    try {
      const card = getCard ? await getCard(ctx.id) : null;
      if (card?.linked_head_sha) head = card.linked_head_sha;
    } catch {
      /* best-effort: fall back to ctx.head */
    }
    const lines = [
      "=== Advisor review ===",
      `doName: ${doName ?? ""}`,
      `cardId: ${ctx.id}`,
      `state: ${ctx.state}`,
      `repo: ${ctx.repo ?? ""}`,
      `head: ${head}`,
      `role: ${advisorRole}`,
      `watch_paths: ${JSON.stringify(watchPaths)}`,
      "",
      `Find the branch for card ${ctx.id} yourself (e.g. git branch -r --list 'origin/*${ctx.id}*'), review the`,
      "linked head above for this stage's concerns, then post a verdict: {status, head, reason?}.",
    ];
    const path = `/tmp/yarradev-prompt-${ctx.id}-${advisorRole}.txt`;
    writeFileSync(path, lines.join("\n") + "\n");
    return path;
  };
}

/** Read the dispatch-context entry for a verdictPath (join key) from the context ledger JSONL. Pure-over-content. */
export function readContextFor(contextContent, verdictPath) {
  if (!contextContent || !verdictPath) return undefined;
  let last = undefined;
  for (const line of contextContent.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e && e.verdictPath === verdictPath) last = e.ctx ?? e.context;
    } catch {
      continue;
    }
  }
  return last;
}

/** Read a file's content if it exists, else "" (treats a missing manifest/consumed/context as empty). */
function readIfPresent(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

// ============================================================================
// CLI body — only runs when invoked directly (`node pass.mjs`)
// ============================================================================

if (import.meta.url === `file://${process.argv[1]}`) {
  const DISPATCH_KINDS = new Set(["work", "respawn", "reclaim"]);

  const cfg = loadConfig();
  const K = cfg.pace?.maxCardsPerPass ?? 1;
  const ttlS = cfg.pace?.claimTtlS ?? 1800;
  // Bounded code-default (#65): a `pace`-less board.json must not inherit an uncapped Infinity ceiling —
  // that would let a single partially-degraded pass park a large batch. 4 matches the shipped board.json.
  const maxConcurrent = cfg.pace?.maxConcurrent ?? 4;
  const breakerCooldownS = cfg.pace?.breakerCooldownS ?? 600;
  const inflightStaleS = Number(cfg.runtime?.inflightStaleS ?? 7200);

  // Lazy-import makeClient (avoid pulling BoardClient at module top so pure-helper imports stay clean of fs).
  const { makeClient } = await import("./plugin-io.mjs");
  const client = makeClient({ role: "orchestrator" });

  const stateDir = resolveStateDir();
  const manifestPath = resolveManifestPath();
  const consumedPath = join(stateDir, CONSUMED_NAME);
  const contextPath = join(stateDir, CONTEXT_NAME);

  const machine = await client.getMachine().catch((e) => {
    process.stderr.write(`[pass] GET /config failed (${e?.message ?? e}); proceeding without REJECT-edge derivation\n`);
    return { transitions: [] };
  });
  // §7: expose the board config's per-role model/effort to dispatch (both external + native modes read
  // process.env). loadRoleOverrides merges this as the highest-precedence layer over local board.json.
  process.env.YARRADEV_BOARD_ROLES = JSON.stringify(machine?.roles ?? {});
  // issue #83: the board-served machine.lifecycle (nodes-authored boards) wins over cfg.lifecycle when
  // present; the fail-open `{ transitions: [] }` fallback above has no .lifecycle key, so a GET /config
  // failure falls straight through to cfg.lifecycle exactly as before.
  const lifecycle = resolveLifecycle(machine, cfg);

  const run = makeRun();
  const dispatch = makeDispatch(cfg.runtime?.dispatchTool, cfg.runtime?.dispatchMode ?? "external");
  const getCard = async (id) => {
    try {
      return await client.getEnriched(id);
    } catch {
      return null;
    }
  };
  const buildAdvisorPrompt = makeBuildAdvisorPrompt(lifecycle, cfg.doName, getCard);

  // --- Phase 1: reconcile landed verdicts (from this pass AND prior-pass dispatches still running) ---
  const manifestContent = readIfPresent(manifestPath);
  const consumedContent = readIfPresent(consumedPath);
  const contextContent = readIfPresent(contextPath);
  const recResults = await reconcileVerdicts({
    manifestContent,
    consumedContent,
    contextContent,
    lifecycle,
    machine,
    run,
    dispatch,
    getCard,
    buildAdvisorPrompt,
    ttlS,
    readVerdict: async (vp) => readFileSync(vp, "utf8"),
    appendConsumed: async (vp) => {
      mkdirSync(stateDir, { recursive: true });
      appendFileSync(consumedPath, JSON.stringify({ verdictPath: vp, consumedAt: new Date().toISOString() }) + "\n");
    },
    readContext: async (vp) => readContextFor(contextContent, vp),
  });
  for (const r of recResults) {
    process.stdout.write(
      JSON.stringify({ phase: "reconcile", ...r }) + "\n",
    );
  }

  // --- 529 circuit breaker + total-concurrency bound (GH #39) ---
  const breakerPath = join(stateDir, BREAKER_NAME);
  const nowMs = Date.now();
  let prevBreaker = { state: "CLOSED", breakerUntil: 0 };
  try {
    const raw = readIfPresent(breakerPath);
    if (raw) prevBreaker = { state: "CLOSED", breakerUntil: 0, ...JSON.parse(raw) };
  } catch {
    /* corrupt breaker file → default CLOSED */
  }
  const inFlightCount = inFlightCardIds(manifestContent, nowMs, inflightStaleS).size;
  const { effectiveK, breaker, saw529 } = decideDispatch({
    recResults, prevBreaker, inFlightCount, K, maxConcurrent, cooldownS: breakerCooldownS, now: nowMs,
  });
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(breakerPath, JSON.stringify(breaker));
  } catch (e) {
    process.stderr.write(`[pass] breaker persist failed: ${e?.message ?? e} (non-fatal)\n`);
  }
  if (breaker.state !== "CLOSED" || saw529) {
    process.stderr.write(
      `[pass] breaker ${breaker.state} (saw529=${saw529}, inFlight=${inFlightCount}/${maxConcurrent}, effectiveK=${effectiveK})\n`,
    );
  }

  // --- Phase 2: list ready cards → split dispatch kinds from sync kinds ---
  const lr = spawnSync("node", [join(SCRIPTS_DIR, "list-ready.mjs")], { encoding: "utf8" });
  if (lr.status !== 0) {
    process.stderr.write(`[pass] list-ready exited ${lr.status}${lr.stderr ? ` — ${lr.stderr.trim()}` : ""}\n`);
    process.exit(lr.status ?? 1);
  }
  const actions = [];
  for (const line of (lr.stdout ?? "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      actions.push(JSON.parse(t));
    } catch {
      /* skip non-JSON stderr bleed-through */
    }
  }
  const dispatchCards = actions.filter((a) => DISPATCH_KINDS.has(a.kind));
  const syncActions = actions.filter((a) => !DISPATCH_KINDS.has(a.kind));

  // --- Phase 2a: sync kinds (advance/promote/escalate) — no dispatch, posted directly ---
  const writeEpicDone = ({ epicId, title, storyCount }) => {
    try {
      writeFileSync("/tmp/yarradev-epic-done", JSON.stringify({ epicId, title, completedAt: new Date().toISOString(), storyCount, bugCount: 0 }));
    } catch (e) {
      process.stderr.write(`[pass] failed to write epic-done signal: ${e?.message ?? e}\n`);
    }
  };
  for (const action of syncActions) {
    const card = action.kind === "promote" ? await getCard(action.id) : null; // epic-done detection
    const res = await applySyncAction(action, { run, ttlS, card, signalEpicDone: writeEpicDone });
    process.stdout.write(JSON.stringify({ phase: "sync", kind: action.kind, id: action.id, ...res }) + "\n");
  }

  // --- Phase 2b: dispatch kinds — bounded fan-out (CLAIM → build-prompt → fire-and-forget dispatch) ---
  // Epic-bounding needs the root-epic priority per card; pre-fetch enriched cards into a map and walk the
  // parent chain (reuses list-ready.mjs's epicPriorityOf shape). This re-fetches what list-ready already did
  // — unavoidable without modifying list-ready to emit epicPriority (a later wiring task).
  const enriched = new Map();
  for (const c of dispatchCards) {
    if (!enriched.has(c.id)) {
      try {
        enriched.set(c.id, await client.getEnriched(c.id));
      } catch {
        enriched.set(c.id, { id: c.id, priority: 100 });
      }
    }
  }
  const epicOf = (card) => {
    let cursor = enriched.get(card.id);
    let depth = 0;
    while (cursor && depth < 50) {
      if (cursor.type === "epic") return cursor.priority ?? 50;
      if (!cursor.parent_id) break;
      cursor = enriched.get(cursor.parent_id);
      depth++;
    }
    return cursor?.priority ?? 100;
  };

  if (effectiveK <= 0) {
    const reason = breaker.state === "OPEN" ? "breaker-open" : "at-capacity";
    process.stdout.write(
      JSON.stringify({ phase: "dispatch", action: "skipped", reason, inFlightCount, breakerState: breaker.state }) + "\n",
    );
  } else {
    const dispatchOut = await dispatchNew({
      cards: dispatchCards,
      K: effectiveK,
      epicOf,
      run,
      dispatch,
      ttlS,
      cfg,
      writeContext: (verdictPath, ctx) => {
        mkdirSync(stateDir, { recursive: true });
        appendFileSync(contextPath, JSON.stringify({ verdictPath, ctx, recordedAt: new Date().toISOString() }) + "\n");
      },
    });
    process.stdout.write(JSON.stringify({ phase: "dispatch", ...dispatchOut }) + "\n");
  }

  process.exit(0);
}
