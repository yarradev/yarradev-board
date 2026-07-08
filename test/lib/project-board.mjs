/*
 * project-board.mjs — shared stub-board test helper.
 *
 * After the config consolidation, apiBase/doName no longer come from YDB_API_BASE/YDB_DO_NAME env — they
 * live in .yarradev/board.json (project-local, read via loadConfig's merge over the shipped
 * board.example.json template). Stub-board spawn tests therefore point the spawned script at a temp project
 * dir whose .yarradev/board.json carries the stub board's apiBase+doName; the script runs with that cwd.
 *
 * The board.json written here is PARTIAL (apiBase/doName only). The lifecycle/pace/runtime are inherited
 * from board.example.json via loadConfig's overlay merge — so the stub board's /config machine MUST still
 * match that shipped lifecycle (tests already build it that way; do not move lifecycle here).
 *
 * Tokens (YDB_TOKEN / YDB_TOKEN_<ROLE>) stay in env — they are secrets and never belonged in config. Call
 * sites keep them in the spawn env object; only apiBase/doName move into this file.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A temp project dir whose .yarradev/board.json points at the stub board (apiBase+doName). Returns the cwd.
 * @param {{ apiBase: string, doName: string, extra?: object }} opts
 * @returns {string} absolute path to a fresh temp cwd (caller does not need to clean up — OS tmpdir)
 */
export function projectBoardDir({ apiBase, doName, extra = {} }) {
  const cwd = mkdtempSync(join(tmpdir(), "ydb-test-"));
  mkdirSync(join(cwd, ".yarradev"), { recursive: true });
  writeFileSync(join(cwd, ".yarradev", "board.json"), JSON.stringify({ apiBase, doName, ...extra }));
  return cwd;
}
