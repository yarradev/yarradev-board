/*
 * yarradev — PLUGIN-SIDE config + token I/O (plain Node, zero deps).
 *
 * These helpers are plugin-only: they load/merge the local board config and resolve the board bearer
 * from env. They are NOT board protocol — the board protocol (BoardClient, decide, reduce, parseVerdict)
 * lives in the vendored orchestrator-core bundle (./vendor/core.mjs). makeClient() below is the single
 * seam that wires this plugin's config+token into a vendored-core BoardClient, so every CLI script drives
 * from the shipped runtime engine rather than a hand-rolled client.
 *
 * Auth: the board bearer comes from env only (never config, never argv) — per ACTING ROLE via
 *       YDB_TOKEN_<ROLE> (e.g. YDB_TOKEN_DEVELOPER) for a per-role board identity, else the shared
 *       YDB_TOKEN. See resolveToken(). Tokens NEVER reach a subagent — the orchestrator posts every act.
 * Config: skills/yarradev-run/config/board.json (gitignored) overrides board.example.json;
 *         YDB_API_BASE / YDB_DO_NAME env vars override either.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assertSafeCommandFields } from "./config-trust.mjs";
import { BoardClient } from "./vendor/core.mjs";

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
  assertSafeCommandFields(cfg);
  return cfg;
}

/**
 * Thin wrapper around assertSafeCommandFields for testability.
 * Called inside loadConfig() — exported so unit tests can verify the gate
 * without needing a temp config directory.
 * @param {object} cfg
 * @returns {object} cfg on success
 * @throws {Error} if any command field is untrusted
 */
export function validateLoadedConfig(cfg) {
  return assertSafeCommandFields(cfg);
}

export function requireToken(tok) {
  const t = tok ?? process.env.YDB_TOKEN;
  if (!t) throw new Error("YDB_TOKEN is not set (board bearer token, shaped <token_id>.<secret>)");
  return t;
}

// Resolve the bearer for an acting ROLE: prefer YDB_TOKEN_<ROLE> (a per-role board identity scoped to
// least-privilege caps), else fall back to the shared YDB_TOKEN. The fallback keeps a single-token setup
// working unchanged; a missing per-role token is logged so a degraded (non-isolated) act is visible.
// Role names map by upper-casing and turning '-' into '_': security-advisor → YDB_TOKEN_SECURITY_ADVISOR.
export function resolveToken(role) {
  if (role) {
    const key = `YDB_TOKEN_${role.toUpperCase().replace(/-/g, "_")}`;
    if (process.env[key]) return process.env[key];
    if (process.env.YDB_TOKEN) {
      process.stderr.write(`[board] ${key} not set → using shared YDB_TOKEN (no per-role identity) for role '${role}'\n`);
    }
  }
  return requireToken();
}

/**
 * Build a vendored-core BoardClient wired to this plugin's config + token.
 *
 * Precedence per field: explicit opt > env var > config file. token precedence:
 * explicit opt.token > YDB_TOKEN_<ROLE> (if opt.role) > shared YDB_TOKEN.
 *
 * This is the ONE place the plugin resolves config/token into the vendored engine's client — the CLI
 * scripts import this instead of constructing a client themselves, so there is exactly one construction
 * seam (and the core bundle stays the single source of board-protocol truth).
 *
 * @param {{ role?: string|null, apiBase?: string, doName?: string, token?: string }} [opts]
 * @returns {BoardClient}
 */
export function makeClient(opts = {}) {
  const role = opts.role ?? null;
  const needCfg = opts.apiBase == null || opts.doName == null;
  const cfg = needCfg ? loadConfig() : {};
  return new BoardClient({
    apiBase: opts.apiBase ?? process.env.YDB_API_BASE ?? cfg.apiBase,
    doName: opts.doName ?? process.env.YDB_DO_NAME ?? cfg.doName,
    token: opts.token ?? resolveToken(role),
    role, // acting board identity (informational on the client); token above encodes the actual identity
  });
}

/**
 * Normalize a vendored-core AppendResult into the CLI scripts' committed/exit contract and print it.
 *
 * The vendored client's methods return an AppendResult ({ outcome, status, seq, applied, blocked_by?, ... }),
 * whereas the plugin's CLI scripts (and the conductor SKILL.md that parses their stdout) expect a
 * { ok, status, outcome } line and an exit code keyed on committed. This maps between the two so the
 * conductor's contract is unchanged.
 *
 * @param {import("./vendor/core.mjs").BoardClient extends never ? never : any} result AppendResult
 * @param {object} [extra] extra fields to include (e.g. { gen } for claim, { blocked_by } for promote)
 * @returns {number} process exit code (0 committed, 1 otherwise)
 */
export function emit(result, extra = {}) {
  const ok = result?.outcome === "committed";
  process.stdout.write(JSON.stringify({ ok, ...extra, status: result?.status, outcome: result?.outcome ?? null }) + "\n");
  return ok ? 0 : 1;
}

/** Extract the granted generation from a CLAIM AppendResult (dispatch.gen, else the item snapshot's gen). */
export function genOf(result) {
  return result?.dispatch?.gen ?? result?.item?.current_gen ?? 0;
}
