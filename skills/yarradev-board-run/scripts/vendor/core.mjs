// GENERATED from @yarradev/orchestrator-core — do not edit; run `pnpm --filter @yarradev/orchestrator-core build`

// src/verdict.ts
var STATUSES = /* @__PURE__ */ new Set(["advance", "reject", "submitted", "question", "error", "veto", "hold", "advice", "clean"]);
function extractJsonBlock(text) {
  const re = /```json\s*([\s\S]*?)```/gi;
  let m;
  let last = null;
  while ((m = re.exec(text)) !== null) last = m[1].trim();
  return last;
}
var err = (reason) => ({ status: "error", reason });
function parseVerdict(text) {
  const block = extractJsonBlock(text);
  if (!block) return err("no fenced ```json verdict block found");
  let raw;
  try {
    raw = JSON.parse(block);
  } catch (e) {
    return err(`verdict JSON parse failed: ${e.message}`);
  }
  if (raw == null || typeof raw !== "object") return err("verdict is not an object");
  const o = raw;
  const status = o.status;
  if (typeof status !== "string" || !STATUSES.has(status)) return err(`unknown verdict status: ${String(status)}`);
  const reason = typeof o.reason === "string" ? { reason: o.reason } : {};
  switch (status) {
    case "advance":
    case "reject":
      return { status, ...typeof o.to === "string" ? { to: o.to } : {}, ...reason };
    case "submitted": {
      const ev = o.evidence;
      if (!ev || typeof ev.repo !== "string" || typeof ev.head !== "string" || typeof ev.pr_number !== "number")
        return err("submitted verdict missing evidence{repo,pr_number,head}");
      return { status, evidence: { repo: ev.repo, prNumber: ev.pr_number, head: ev.head }, ...reason };
    }
    case "question":
      if (typeof o.category !== "string") return err("question verdict missing category");
      return { status, category: o.category, ...reason };
    case "error":
      return { status, ...reason };
    case "veto":
    case "hold":
    case "advice":
    case "clean":
      if (typeof o.role !== "string" || typeof o.head !== "string") return err(`${status} verdict missing role/head`);
      return { status, role: o.role, head: o.head, ...reason };
    default:
      return err("unreachable");
  }
}

// src/config.ts
var DEFAULT_BUDGETS = {
  transition_budget: 50,
  respawn_window_ms: 6e4
};
var stageOf = (lifecycle, state) => lifecycle[state];
var isTerminal = (st) => st != null && st.to == null;
var advisorRoleFor = (st) => st?.advisors?.[0]?.role;

// src/decide.ts
var leased = (card, nowMs) => card.lease_expiry_ts != null && card.lease_expiry_ts > nowMs;
function decide(card, lifecycle, _policy, nowMs) {
  const st = lifecycle[card.state];
  if (!st) return { kind: "escalate", reason: `unknown-stage: ${card.state}` };
  if (st.to == null) return { kind: "noop", reason: "terminal" };
  const transitions = card.transitions_count ?? 0;
  if (transitions >= DEFAULT_BUDGETS.transition_budget)
    return { kind: "escalate", reason: `transition-budget (${transitions}/${DEFAULT_BUDGETS.transition_budget})` };
  if (card.veto_held && card.vetoes.length === 0)
    return { kind: "escalate", reason: "board-drift: veto_held with no open veto" };
  if (card.blocked && card.open_questions.length === 0)
    return { kind: "escalate", reason: "board-drift: blocked with no open question (would park forever)" };
  if (card.blocked) {
    if (card.open_questions.some((q) => q.deadline_ts != null && q.deadline_ts <= nowMs))
      return { kind: "escalate", reason: "blocked: decision deadline passed" };
    return { kind: "noop", reason: "blocked" };
  }
  if (card.veto_held) return { kind: "noop", reason: "veto-open" };
  if (card.hold_open) return { kind: "noop", reason: "hold-open" };
  if (card.open_questions.length > 0) return { kind: "work", role: st.owner, to: st.to };
  if (st.gate === "barrier") {
    if (card.children_total === 0)
      return { kind: "escalate", reason: "fan-in barrier with 0 child stories (decompose produced none?)" };
    if (card.children_done >= card.children_total)
      return { kind: "advance", to: st.to, reason: `fan-in: all ${card.children_total} children done` };
    return { kind: "noop", reason: `fan-in ${card.children_done}/${card.children_total}` };
  }
  if (st.gate === "human") return { kind: "promote", to: st.to };
  if (st.gate === "mechanical" && card.linked_head_sha != null) {
    const ci = card.ci_rollup || "absent";
    if (ci === "success") {
      if (leased(card, nowMs)) return { kind: "noop", reason: "leased" };
      const nt = card.next_transitions.find((t) => t.to === st.to);
      if (nt && nt.failing.includes("advisor_clear")) {
        return { kind: "work", role: advisorRoleFor(st) ?? st.owner, to: st.to };
      }
      return { kind: "advance", role: st.owner, to: st.to };
    }
    if (ci === "failure") {
      if (leased(card, nowMs)) return { kind: "noop", reason: "leased" };
      const since = card.parked_since_ts ?? nowMs;
      if (nowMs - since > DEFAULT_BUDGETS.respawn_window_ms) return { kind: "escalate", reason: "ci-stalled" };
      return { kind: "respawn", role: st.owner };
    }
    return { kind: "noop", reason: `ci-${ci}` };
  }
  if (card.lease_expiry_ts != null) {
    if (card.lease_expiry_ts > nowMs) return { kind: "noop", reason: "leased" };
    return { kind: "reclaim", role: st.owner, to: st.to };
  }
  return { kind: "work", role: st.owner, to: st.to };
}

// src/reduce.ts
var escalate = (card, reason) => [
  { type: "ESCALATE", item_id: card.id, data: { reason } }
];
function reduce(verdict, card, lifecycle) {
  const st = lifecycle[card.state];
  switch (verdict.status) {
    case "advance": {
      if (!st?.to) return escalate(card, `advance from ${card.state} but it has no forward edge`);
      if (verdict.to && verdict.to !== st.to) {
        return escalate(card, `MOVE names to-stage:${verdict.to} but ${card.state}'s only forward edge is \u2192${st.to}`);
      }
      return [{ type: "MOVE", item_id: card.id, gen: card.current_gen, data: { to: st.to } }];
    }
    case "reject": {
      const to = verdict.to;
      const validBackEdge = to != null && lifecycle[to]?.to === card.state;
      if (!validBackEdge) return escalate(card, `REJECT on undefined backward edge ${card.state}->${to ?? "?"}`);
      return [{ type: "REJECT", item_id: card.id, gen: card.current_gen, data: { to } }];
    }
    case "submitted": {
      const { repo, prNumber, head } = verdict.evidence;
      const data = { repo, pr_number: prNumber, head };
      return card.linked_head_sha == null ? [{ type: "LINK_PR", item_id: card.id, gen: card.current_gen, data }] : [{ type: "PUSH", item_id: card.id, gen: card.current_gen, data }];
    }
    case "question":
      return [{ type: "ASK", item_id: card.id, data: { cat: verdict.category, text: verdict.reason ?? "" } }];
    case "error":
      return escalate(card, `worker error: ${verdict.reason ?? "unspecified"}`);
    case "veto":
      return [{ type: "VETO", item_id: card.id, data: { role: verdict.role, head: verdict.head, reason: verdict.reason ?? "" } }];
    case "hold":
      return [{ type: "HOLD", item_id: card.id, data: { role: verdict.role, head: verdict.head, reason: verdict.reason ?? "" } }];
    case "advice":
    case "clean":
      return [{ type: "ADVICE", item_id: card.id, data: { reviewed_head: verdict.head } }];
    default: {
      const _exhaustive = verdict;
      return escalate(card, `reduce: unhandled verdict (${_exhaustive.status})`);
    }
  }
}

// src/boardClient.ts
var OUTCOME_FOR_STATUS = {
  403: "unauthorized",
  409: "fenced",
  422: "bad_act"
};
var BoardClient = class {
  apiBase;
  doName;
  token;
  role;
  fetchImpl;
  constructor(opts) {
    this.apiBase = opts.apiBase;
    this.doName = opts.doName;
    this.token = opts.token;
    this.role = opts.role;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }
  url(suffix) {
    return `${this.apiBase}/boards/${encodeURIComponent(this.doName)}${suffix}`;
  }
  headers() {
    return { "content-type": "application/json", authorization: `Bearer ${this.token}` };
  }
  async getJson(suffix) {
    const res = await this.fetchImpl(this.url(suffix), { headers: this.headers() });
    if (!res.ok) return null;
    return await res.json();
  }
  // ── reads ──────────────────────────────────────────────────────────────────
  async listCards(opts = {}) {
    const params = new URLSearchParams();
    params.set("limit", String(opts.limit ?? 200));
    if (opts.state) params.set("state", opts.state);
    if (opts.after) params.set("after", opts.after);
    const body = await this.getJson(
      `/cards?${params.toString()}`
    );
    if (body == null) return [];
    return Array.isArray(body) ? body : body.items ?? [];
  }
  async getEnriched(id) {
    return this.getJson(`/cards/${encodeURIComponent(id)}/enriched`);
  }
  async getMachine() {
    return this.getJson("/config");
  }
  async acts(after = 0, limit = 100) {
    const params = new URLSearchParams({ after: String(after), limit: String(limit) });
    return await this.getJson(`/acts?${params.toString()}`) ?? { acts: [], nextAfterSeq: null };
  }
  // ── write core ─────────────────────────────────────────────────────────────
  body(a) {
    return { type: a.type, item_id: a.item_id, gen: a.gen ?? null, data: a.data ?? {} };
  }
  /** POST a single act; identity is server-set from the bearer — never send by/byKind/roles/role. */
  async act(a) {
    const res = await this.fetchImpl(this.url("/acts"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.body(a))
    });
    return this.toAppendResult(res);
  }
  /**
   * Coerce a /acts response into an AppendResult. handleAct returns a well-formed AppendResult (with
   * `outcome`) for every DO outcome (202/403/409/422) — but the API's own validation/auth guards
   * (invalid JSON 400, unknown/bad act 422, forbidden 403, etc.) return `{error}` with NO outcome.
   * A blind `as AppendResult` cast on those yields an all-undefined object and silently swallows the
   * error; mirror submit()'s defensiveness and synthesize an error-shaped result instead.
   */
  async toAppendResult(res) {
    const body = await res.json().catch(() => ({}));
    if (typeof body.outcome === "string") return body;
    return {
      outcome: OUTCOME_FOR_STATUS[res.status] ?? "bad_act",
      status: res.status,
      seq: -1,
      applied: false,
      reason: body.error ?? res.statusText ?? `act failed (HTTP ${res.status})`
    };
  }
  /** POST a batch of acts (all-or-nothing); returns [] if the batch was rejected (no results). */
  async submit(acts) {
    const res = await this.fetchImpl(this.url("/batch"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ acts: acts.map((a) => this.body(a)) })
    });
    const parsed = await res.json();
    return parsed.results ?? [];
  }
  // ── act helpers (thin wrappers over act()) ──────────────────────────────────
  claim(id, role, ttlS = 1800) {
    return this.act({ type: "CLAIM", item_id: id, data: { role, ttl_s: ttlS } });
  }
  move(id, gen, to) {
    return this.act({ type: "MOVE", item_id: id, gen, data: { to } });
  }
  // Distinct act type from MOVE: the board only matches a backward transition declared as
  // type:"REJECT", and bounce budgets fire on REJECT. gen-required, like MOVE.
  reject(id, gen, to) {
    return this.act({ type: "REJECT", item_id: id, gen, data: { to } });
  }
  // First submission: creates the pr_link row CI facts head-match on. gen-required.
  linkPr(id, gen, data) {
    return this.act({ type: "LINK_PR", item_id: id, gen, data });
  }
  // Re-point an EXISTING pr_link's head (respawn-to-fix pushed new commits). gen-required.
  push(id, gen, data) {
    return this.act({ type: "PUSH", item_id: id, gen, data });
  }
  // Security-advisor verdicts (gen-exempt). Sets veto_held/hold_open, parking the card until an
  // accountable human clears it (clearVeto/clearHold below).
  veto(id, reason = "", head = null) {
    return this.act({ type: "VETO", item_id: id, data: { role: "security-advisor", reason, head } });
  }
  hold(id, reason = "", head = null) {
    return this.act({ type: "HOLD", item_id: id, data: { role: "security-advisor", reason, head } });
  }
  // Accountable-human clear (gen-exempt). The board authorizes CLEAR_VETO only for a clear_authority
  // signatory identity.
  clearVeto(id) {
    return this.act({ type: "CLEAR_VETO", item_id: id, data: { role: "security-advisor" } });
  }
  // GAP (missing in both lib.mjs and the old board-client): clears a HOLD. The board's hold-clear act
  // type is CLEAR, not a bespoke "CLEAR_HOLD" — see packages/shared/src/acts.ts ALL_ACT_TYPES.
  clearHold(id) {
    return this.act({ type: "CLEAR", item_id: id, data: { role: "security-advisor" } });
  }
  clearLease(id, gen) {
    return this.act({ type: "CLEAR_LEASE", item_id: id, gen, data: {} });
  }
  // GAP: a generic ASK (open question), distinct from escalate()'s fixed cat:"escalation".
  // The board's ASK fold (workers/board/src/storage.ts ~L831) reads data.text (and data.cat) — it
  // does NOT read data.reason, so the human-facing reason is posted under the `text` key the fold
  // actually persists into the question row. Method signature unchanged (reason arg name kept for
  // callers like escalate.mjs); only the wire key changes.
  ask(id, cat, reason = "") {
    return this.act({ type: "ASK", item_id: id, data: { cat, text: reason } });
  }
  // Surface a card for human attention (gen-exempt). Uses the dedicated ESCALATE act, whose fold sets
  // a NON-blocking escalated/escalated_reason surfacing flag (workers/board/src/storage.ts) — never
  // touches state/blocked/gen. (lib.mjs mis-ported this as ASK, which inserts a question row and
  // recomputeBlocked → BLOCKS the card; that conflated "flag for attention" with "park pending answer".)
  escalate(id, reason = "") {
    return this.act({ type: "ESCALATE", item_id: id, data: { reason } });
  }
  // GAP: closes an open question (resumes decide()). Post as a human identity — ANSWER requires
  // human governance.
  answer(id, text = "Resume the card.") {
    return this.act({ type: "ANSWER", item_id: id, data: { text } });
  }
  // Accountable-human production GO (gen-exempt). The board authorizes HUMAN_GO only for a
  // byKind:"human" identity — run this as a human bearer, never the orchestrator's agent token.
  humanGo(id) {
    return this.act({ type: "HUMAN_GO", item_id: id, data: {} });
  }
};

// src/index.ts
var version = "0.1.0";
export {
  BoardClient,
  DEFAULT_BUDGETS,
  advisorRoleFor,
  decide,
  isTerminal,
  parseVerdict,
  reduce,
  stageOf,
  version
};
