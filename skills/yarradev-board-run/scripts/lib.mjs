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

export function loadConfig() {
  let cfg;
  for (const name of ["board.json", "board.example.json"]) {
    try {
      cfg = JSON.parse(readFileSync(join(CONFIG_DIR, name), "utf8"));
      break;
    } catch {
      /* try next */
    }
  }
  if (!cfg) throw new Error(`no board config (looked for board.json / board.example.json in ${CONFIG_DIR})`);
  if (process.env.YDB_API_BASE) cfg.apiBase = process.env.YDB_API_BASE;
  if (process.env.YDB_DO_NAME) cfg.doName = process.env.YDB_DO_NAME;
  return cfg;
}

export function requireToken(tok) {
  const t = tok ?? process.env.YDB_TOKEN;
  if (!t) throw new Error("YDB_TOKEN is not set (board bearer token, e.g. orch1.s3cret)");
  return t;
}

export class BoardClient {
  /** opts: { apiBase, doName, token } — any omitted value falls back to config/env. */
  constructor(opts = {}) {
    const needCfg = opts.apiBase == null || opts.doName == null;
    const cfg = needCfg ? loadConfig() : {};
    this.apiBase = opts.apiBase ?? cfg.apiBase;
    this.doName = opts.doName ?? cfg.doName;
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

  async clearLease(id, gen) {
    const { status, outcome } = await this.act({ type: "CLEAR_LEASE", item_id: id, gen });
    return { ok: outcome === "committed", status, outcome };
  }
}
