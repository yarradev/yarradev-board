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
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./plugin-io.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCRIPTS_DIR = HERE;

// State dir mirrors in-flight.mjs / dispatch-and-wait.mjs ($XDG_DATA_HOME or ~/.local/share/claude-bg).
function defaultStateDir() {
  return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share", "claude-bg");
}
const MANIFEST_NAME = "dispatch-manifest.jsonl";
const CONSUMED_NAME = "dispatch-consumed.jsonl";
const CONTEXT_NAME = "dispatch-context.jsonl";

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
      return { acts, dispatches, advisorClear422, spawnDeferred };
    }

    // ---- reject (worker carries `to`; advisor omits it → conductor derives) ---
    if (status === "reject") {
      if (verdict.to != null) {
        // worker reject — backward edge from the verdict, posted under the stage owner.
        const r = await call("reject.mjs", [id, gen, verdict.to, ctx.role]);
        if (r && !r.ok && isBounceBudget(r)) {
          await call("escalate.mjs", [id, `bounce budget: ${ctx.state}→${verdict.to}`]);
        }
      } else {
        // advisor reject — derive the single backward edge from the compiled machine.
        const derivedTo = rejectTargetOf(machine, ctx.state);
        if (derivedTo != null) {
          await call("reject.mjs", [id, gen, derivedTo, ctx.role]); // under the ADVISOR's role, not the owner
        } else {
          // 0 or >1 REJECT edges → ambiguous; never guess.
          await call("escalate.mjs", [id, `reject edge ambiguous for state ${ctx.state}`]);
        }
      }
      return { acts, dispatches, advisorClear422, spawnDeferred };
    }

    // ---- mechanical submitted (LINK_PR first submission / PUSH respawn fix) ---
    if (status === "submitted") {
      const ev = verdict.evidence ?? {};
      const { repo, pr_number: pr, head } = ev;
      if (ctx.kind === "respawn") {
        await call("push.mjs", [id, gen, repo, pr, head]); // pr_link already exists → re-point head
      } else {
        await call("link-pr.mjs", [id, gen, repo, pr, head]); // first submission (work/reclaim) → create pr_link
      }
      // Recover stranded CI (GH #21) — CI completion often lands before LINK_PR creates the row.
      await call("reattach-ci.mjs", [id, repo, pr, head]);
      return { acts, dispatches, advisorClear422, spawnDeferred };
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
          break; // CREATE failure → stop issuing further CREATEs; next pass re-dispatches the analyst.
        }
      }
      if (allCreated) {
        await call("move.mjs", [id, gen, ctx.to, ctx.role]); // advance the epic to the barrier stage
      }
      return { acts, dispatches, advisorClear422, spawnDeferred };
    }

    // ---- question → escalate (park for a human) ------------------------------
    if (status === "question") {
      const reason = verdict.reason ?? verdict.question ?? "question";
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
      await call("advice.mjs", adviceArgs); // records a CLEAN review → advisor_clear goes non-vacuous

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
      return { acts, dispatches, advisorClear422, spawnDeferred };
    }

    // ---- advisor veto/hold (security-advisor's binding verdicts) -------------
    if (status === "veto" || status === "hold") {
      const script = status === "veto" ? "veto.mjs" : "hold.mjs";
      // veto.mjs/hold.mjs hardcode the security-advisor identity (the only advisor with veto/hold authority);
      // no --role flag. Args: <id> <head> [reason...].
      const args = [id, verdict.head];
      if (verdict.reason != null && verdict.reason !== "") args.push(verdict.reason);
      await call(script, args);
      return { acts, dispatches, advisorClear422, spawnDeferred };
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
      const prompt = await run("build-prompt.mjs", [card.role, card.id, "--to", card.to]);
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
      dispatched.push({ role: card.role, cardId: card.id, promptFile, verdictPath });
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

      // re-CLAIM — fresh gen (the #27 recovery: a verdict that landed past lease-TTL still posts).
      const claim = await run("claim.mjs", [cardId, role, ttlS]);
      if (!claim || !claim.ok) {
        const reason =
          claim?.status === 409 ? "stale verdict (card moved on)" : `claim ${claim?.status ?? "failed"}`;
        logger(`[pass] reconcile ${verdictPath}: ${reason}; consuming`);
        await appendConsumed(verdictPath);
        results.push({ verdictPath, cardId, outcome: "skipped", reason });
        continue;
      }
      const gen = claim.gen;

      if (verdict == null) {
        // No parseable block → post nothing (SKILL.md: log; the card re-dispatches next pass via dispatchNew).
        logger(`[pass] reconcile ${verdictPath}: no parseable verdict block; consuming`);
        await run("clear-lease.mjs", [cardId, gen]);
        await appendConsumed(verdictPath);
        results.push({ verdictPath, cardId, outcome: "no-parse" });
        continue;
      }

      // Recover the dispatch context (kind/to/state/role) recorded at dispatch time; fall back to the
      // manifest's minimal fields if the context ledger has no entry (older dispatch / write failure).
      const recorded = await readContext(verdictPath);
      const ctx = {
        id: cardId,
        role,
        gen,
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

      // CLEAR_LEASE — always, in every branch (the caller owns this; routeVerdict never clears).
      await run("clear-lease.mjs", [cardId, gen]);
      await appendConsumed(verdictPath);
      results.push({
        verdictPath,
        cardId,
        outcome: r.error ? "error" : "routed",
        advisorClear422: r.advisorClear422,
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

/** Build the real fire-and-forget `dispatch(role, cardId, promptFile)`: spawnSync yarradev-dispatch. */
export function makeDispatch(toolPath) {
  const tool = toolPath ?? process.env.YARRADEV_DISPATCH ?? join(homedir(), "work", "tools", "yarradev-dispatch");
  return async (role, cardId, promptFile) => {
    const r = spawnSync(tool, [role, cardId, promptFile], { encoding: "utf8", env: sanitizeEnv(process.env) });
    if (r.status !== 0) {
      throw new Error(
        `yarradev-dispatch exited ${r.status}${r.stderr ? ` — ${r.stderr.trim()}` : ""}`,
      );
    }
    const vp = (r.stdout ?? "").trim();
    if (!vp) throw new Error("yarradev-dispatch printed no verdict path on stdout");
    return vp;
  };
}

/** Build the real advisor-prompt writer (the 422 async-dispatch path). Minimal V1 — repo/branch/head/watch_paths. */
export function makeBuildAdvisorPrompt(lifecycle, doName) {
  return (ctx, advisorRole) => {
    const advisor = lifecycle?.[ctx.state]?.advisors?.find((a) => a?.role === advisorRole);
    const watchPaths = Array.isArray(advisor?.watch_paths) ? advisor.watch_paths : [];
    const lines = [
      "=== Advisor review ===",
      `doName: ${doName ?? ""}`,
      `cardId: ${ctx.id}`,
      `state: ${ctx.state}`,
      `repo: ${ctx.repo ?? ""}`,
      `branch: ${ctx.branch ?? ""}`,
      `head: ${ctx.head ?? ""}`,
      `role: ${advisorRole}`,
      `watch_paths: ${JSON.stringify(watchPaths)}`,
      "",
      "Review the linked head for this stage's concerns. Post a verdict: {status, head, reason?}.",
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

  // Context management (epic-context-clearing): if the prep-clear flag is set (by the yarradev-loop wrapper
  // on CTX%≥60%, or by the pass-count fallback below), reconcile in-flight verdicts but do NOT claim/dispatch
  // new cards — then exit so the wrapper restarts the session with clean context.
  const PREP_CLEAR = "/tmp/yarradev-prep-clear";
  const PASS_COUNT = "/tmp/yarradev-epic-pass-count";
  const skipDispatch = existsSync(PREP_CLEAR);
  if (skipDispatch) process.stderr.write("[pass] prep-clear set — reconciling in-flight only, no new dispatch\n");

  // Lazy-import makeClient (avoid pulling BoardClient at module top so pure-helper imports stay clean of fs).
  const { makeClient } = await import("./plugin-io.mjs");
  const client = makeClient({ role: "orchestrator" });

  const stateDir = defaultStateDir();
  const manifestPath = join(stateDir, MANIFEST_NAME);
  const consumedPath = join(stateDir, CONSUMED_NAME);
  const contextPath = join(stateDir, CONTEXT_NAME);

  const lifecycle = cfg.lifecycle;
  const machine = await client.getMachine().catch((e) => {
    process.stderr.write(`[pass] GET /config failed (${e?.message ?? e}); proceeding without REJECT-edge derivation\n`);
    return { transitions: [] };
  });

  const run = makeRun();
  const dispatch = makeDispatch();
  const buildAdvisorPrompt = makeBuildAdvisorPrompt(lifecycle, cfg.doName);
  const getCard = async (id) => {
    try {
      return await client.getEnriched(id);
    } catch {
      return null;
    }
  };

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

  if (skipDispatch) {
    process.stdout.write(JSON.stringify({ phase: "dispatch", action: "skipped", reason: "prep-clear" }) + "\n");
  } else {
    const dispatchOut = await dispatchNew({
      cards: dispatchCards,
      K,
      epicOf,
      run,
      dispatch,
      ttlS,
      writeContext: (verdictPath, ctx) => {
        mkdirSync(stateDir, { recursive: true });
        appendFileSync(contextPath, JSON.stringify({ verdictPath, ctx, recordedAt: new Date().toISOString() }) + "\n");
      },
    });
    process.stdout.write(JSON.stringify({ phase: "dispatch", ...dispatchOut }) + "\n");

    // Pass-count fallback (when statusline CTX% isn't available): ~3.3h at 5-min intervals → prep-clear,
    // so the next pass reconciles-only and the wrapper restarts with clean context.
    try {
      const count = Number(readFileSync(PASS_COUNT, "utf8")) || 0;
      const next = count + 1;
      writeFileSync(PASS_COUNT, String(next));
      if (next >= 40 && !existsSync(PREP_CLEAR)) {
        writeFileSync(PREP_CLEAR, "");
        process.stderr.write("[pass] pass-count reached 40 → wrote prep-clear (next pass reconciles-only + exits)\n");
      }
    } catch (e) {
      process.stderr.write(`[pass] pass-count update failed: ${e?.message ?? e}\n`);
    }
  }

  process.exit(0);
}
