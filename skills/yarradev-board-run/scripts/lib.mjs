/*
 * yarradev-board — board HTTP client + config/token loaders (plain Node, global fetch, zero deps).
 *
 * PROVENANCE: BoardClient is ported (copied + trimmed) from
 *   yarradev-platform/orchestrator/src/client.ts (HttpBoardClient).
 * Keep the act shapes (CLAIM/MOVE/CLEAR_LEASE) and the gen handling in sync with that source.
 *
 * Auth: the board bearer token comes ONLY from the YDB_TOKEN env var (never config, never argv).
 * Config: skills/yarradev-board-run/config/board.json (gitignored) overrides board.example.json;
 *         YDB_API_BASE / YDB_DO_NAME env vars override either.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(HERE, "..", "config");

function readJsonIfPresent(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return undefined; // absent is fine
    throw e; // permission/IO error — surface it
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid JSON in ${path}: ${e.message}`); // present-but-malformed must NOT be silently masked
  }
}

export function loadConfig() {
  // board.example.json is the committed template (base); board.json (gitignored) overlays it field-by-field,
  // so a partial board.json (e.g. just apiBase/doName) still inherits lifecycle + pace from the template.
  const base = readJsonIfPresent(join(CONFIG_DIR, "board.example.json")) ?? {};
  const over = readJsonIfPresent(join(CONFIG_DIR, "board.json")) ?? {};
  const cfg = {
    ...base,
    ...over,
    pace: { ...(base.pace ?? {}), ...(over.pace ?? {}) },
    lifecycle: over.lifecycle ?? base.lifecycle,
  };
  if (process.env.YDB_API_BASE) cfg.apiBase = process.env.YDB_API_BASE;
  if (process.env.YDB_DO_NAME) cfg.doName = process.env.YDB_DO_NAME;
  if (!cfg.apiBase || !cfg.doName) throw new Error(`board config missing apiBase/doName (config dir ${CONFIG_DIR})`);
  if (!cfg.lifecycle) throw new Error(`board config missing lifecycle (config dir ${CONFIG_DIR})`);
  return cfg;
}

export function requireToken(tok) {
  const t = tok ?? process.env.YDB_TOKEN;
  if (!t) throw new Error("YDB_TOKEN is not set (board bearer token, shaped <token_id>.<secret>)");
  return t;
}

export class BoardClient {
  /** opts: { apiBase, doName, token }. Precedence per field: explicit opt > env var > config file. */
  constructor(opts = {}) {
    const needCfg = opts.apiBase == null || opts.doName == null;
    const cfg = needCfg ? loadConfig() : {};
    this.apiBase = opts.apiBase ?? process.env.YDB_API_BASE ?? cfg.apiBase;
    this.doName = opts.doName ?? process.env.YDB_DO_NAME ?? cfg.doName;
    this.token = requireToken(opts.token);
  }

  url(suffix) {
    return `${this.apiBase}/boards/${encodeURIComponent(this.doName)}${suffix}`;
  }
  headers() {
    return { "content-type": "application/json", Authorization: `Bearer ${this.token}` };
  }

  /** POST a raw act; returns { status, json, outcome }. */
  async act(body) {
    const res = await fetch(this.url("/acts"), { method: "POST", headers: this.headers(), body: JSON.stringify(body) });
    let json = {};
    try {
      json = await res.json();
    } catch {
      /* empty body */
    }
    return { status: res.status, json, outcome: json.outcome ?? null };
  }

  async listCards() {
    const res = await fetch(this.url("/cards?limit=200"), { headers: this.headers() });
    const body = await res.json().catch(() => ({}));
    return (body.items ?? []).map((i) => ({
      id: i.id,
      state: i.state,
      blocked: i.blocked,
      current_gen: i.current_gen,
      lease_expiry_ts: i.lease_expiry_ts,
      title: i.title ?? null, // the card's intent — carried so the orchestrator can pass it to subagents
      ci_rollup: i.ci_rollup ?? "absent", // mechanical-gate input: success|pending|failure|blocked|absent
      linked_head_sha: i.linked_head_sha ?? null, // "PR submitted" signal for the mechanical gate
      lease_role: i.lease_role ?? null, // informational (decide uses stage.owner, not this)
      transitions_count: i.transitions_count ?? 0, // board-counted thrash tally (MOVE/REJECT) → transition budget
      parked_since_ts: i.parked_since_ts ?? 0, // entry-to-state ts → time-bounds the in-place CI-failure loop
    }));
  }

  async claim(id, role, ttlS = 1800) {
    const { status, json, outcome } = await this.act({ type: "CLAIM", item_id: id, data: { role, ttl_s: ttlS } });
    const gen = json.dispatch?.gen ?? json.item?.current_gen ?? 0;
    return { ok: outcome === "committed", gen, status, outcome };
  }

  async move(id, gen, to) {
    const { status, outcome } = await this.act({ type: "MOVE", item_id: id, gen, data: { to } });
    return { ok: outcome === "committed", status, outcome };
  }

  // Backward edge (reject). Distinct act type from MOVE: the board only matches a backward transition
  // declared as type:"REJECT", and bounce budgets fire on REJECT. gen-required, like MOVE.
  async reject(id, gen, to) {
    const { status, outcome } = await this.act({ type: "REJECT", item_id: id, gen, data: { to } });
    return { ok: outcome === "committed", status, outcome };
  }

  // Link a PR head to the card (FIRST submission). gen-required. Sets linked_head_sha + creates the
  // pr_link row that CI facts head-match on. Use this when decide() said "work" (no PR yet) — NOT as a
  // substitute for push() (a PUSH with no prior pr_link row strands CI forever).
  async linkPr(id, gen, { repo, pr_number, head }) {
    const { status, outcome } = await this.act({ type: "LINK_PR", item_id: id, gen, data: { repo, pr_number, head } });
    return { ok: outcome === "committed", status, outcome };
  }

  // Re-point an EXISTING pr_link's head (a re-spawn-to-fix pushed new commits). gen-required.
  // Use only when decide() said "respawn" — the pr_link row is guaranteed to exist.
  async push(id, gen, { repo, pr_number, head }) {
    const { status, outcome } = await this.act({ type: "PUSH", item_id: id, gen, data: { repo, pr_number, head } });
    return { ok: outcome === "committed", status, outcome };
  }

  // Park a card for a human via an open question (ASK, gen-exempt → no gen). The board sets
  // blocked=true; decide() then skips it until a human posts ANSWER. Used on budget exhaustion.
  async escalate(id, reason = "") {
    const { status, outcome } = await this.act({ type: "ASK", item_id: id, data: { cat: "escalation", reason } });
    return { ok: outcome === "committed", status, outcome };
  }

  async clearLease(id, gen) {
    const { status, outcome } = await this.act({ type: "CLEAR_LEASE", item_id: id, gen });
    return { ok: outcome === "committed", status, outcome };
  }
}
