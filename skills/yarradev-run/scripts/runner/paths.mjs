import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export function dataDir(env = process.env) {
  if (process.platform === "win32") return env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
}
export function stateDir(env = process.env) {
  return env.YARRADEV_STATE_DIR ?? join(dataDir(env), "yarradev");
}
export function manifestPath(env = process.env) {
  return join(stateDir(env), "dispatch-manifest.jsonl");
}
export function logDir(env = process.env) {
  return join(stateDir(env), "logs");
}
export function resolveHome(env = process.env) {
  if (env.YARRADEV_HOME) return env.YARRADEV_HOME;
  if (env.CLAUDE_PLUGIN_ROOT) return env.CLAUDE_PLUGIN_ROOT;
  // this file is <root>/skills/yarradev-run/scripts/runner/paths.mjs → up 4
  return dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));
}
