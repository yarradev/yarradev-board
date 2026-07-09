#!/usr/bin/env node
import { loadConfig } from "../skills/yarradev-run/scripts/plugin-io.mjs";
import { createDaemon, spawnPass, startSources } from "../skills/yarradev-run/scripts/runner/daemon.mjs";
import { createControlPlane } from "../skills/yarradev-run/scripts/runner/control-plane.mjs";
import { buildStatus, inflightRows } from "../skills/yarradev-run/scripts/runner/state.mjs";
import { manifestPath, resolveHome, stateDir } from "../skills/yarradev-run/scripts/runner/paths.mjs";
import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function buildActions({ daemon, stopSources, getServer }) {
  return {
    pause: () => { daemon.pause(); return { ok: true, paused: true }; },
    resume: () => { daemon.resume(); return { ok: true, paused: false }; },
    tick: () => { daemon.requestTick(); return { ok: true }; },
    retry: () => { daemon.requestTick(); return { ok: true }; }, // lease-clear added when reconciled next pass
    // pause() FIRST: without it, an in-flight loop with dirty=true (a tick already queued while
    // the current pass runs) fires one more coalesced runPass after stop() has torn down sources.
    stop: () => { daemon.pause(); stopSources?.(); getServer?.()?.close(); return { ok: true, stopped: true }; },
  };
}

/**
 * Ensure the state dir and manifest file exist BEFORE startSources() calls fs.watch() on it.
 * On a fresh machine the manifest file doesn't exist yet, so fs.watch() throws synchronously;
 * startSources() catches that and leaves `watcher = null` for the daemon's whole lifetime — the
 * "fire early when a verdict lands" feature silently never activates (falls back to interval-only
 * polling). Touching the file first (empty, if absent) makes watch() attach successfully; dispatch.mjs
 * and pass.mjs already tolerate an empty/missing manifest (readIfPresent / append), so this is safe.
 * @returns {string} the manifest path (for callers that want it)
 */
export function ensureManifestFile(env = process.env) {
  mkdirSync(stateDir(env), { recursive: true });
  const mp = manifestPath(env);
  if (!existsSync(mp)) writeFileSync(mp, "");
  return mp;
}
export function buildProvider({ daemon, config, env }) {
  const staleS = Number(config.runtime?.inflightStaleS ?? 7200);
  const read = () => { try { return readFileSync(manifestPath(env), "utf8"); } catch { return ""; } };
  return {
    status: () => buildStatus({ paused: daemon.isPaused(), intervalMs: (config.pace?.minLoopIntervalS ?? 300) * 1000, lastTick: daemon.lastTick(), nextTickAt: null, breaker: "CLOSED", passRunning: daemon.passRunning(), now: Date.now() }),
    inflight: () => inflightRows(read(), Date.now(), staleS),
    recent: () => [daemon.lastTick()].filter(Boolean),
    attention: () => [], cost: () => ({}),
    logs: () => "", explain: () => ({}),
  };
}

async function run(env = process.env) {
  const home = resolveHome(env);
  const passPath = join(home, "skills", "yarradev-run", "scripts", "pass.mjs");
  const config = loadConfig();
  const intervalMs = (config.pace?.minLoopIntervalS ?? 300) * 1000;
  const runPass = () => spawnPass({ passPath, env: { ...env, YARRADEV_HOME: home }, timeoutMs: (config.runner?.passTimeout ?? 120) * 1000 });
  const daemon = createDaemon({ runPass, intervalMs });
  // Touch the manifest file BEFORE startSources() so fs.watch() attaches on a fresh machine (see
  // ensureManifestFile's docstring) — otherwise the watch silently never activates.
  ensureManifestFile(env);
  const stopSources = startSources(daemon, { manifestFile: manifestPath(env), intervalMs, debounceMs: config.runner?.debounceMs ?? 750 });
  let server;
  const actions = buildActions({ daemon, stopSources, getServer: () => server });
  server = createControlPlane({ provider: buildProvider({ daemon, config, env }), actions });
  const port = config.runner?.port ?? 4599;
  server.listen(port, "127.0.0.1", () => process.stderr.write(`yarradev-run: control plane on http://127.0.0.1:${port}\n`));
  daemon.requestTick(); // first pass immediately
}

export function clientUrl(cmd, port) { return `http://127.0.0.1:${port}/${cmd}`; }
const GET = new Set(["status", "logs"]);
async function client(cmd, port) {
  const r = await fetch(clientUrl(cmd, port), { method: GET.has(cmd) ? "GET" : "POST" });
  process.stdout.write(JSON.stringify(await r.json(), null, 2) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2] ?? "run";
  if (cmd === "run") run();
  else {
    const config = loadConfig();
    const port = config.runner?.port ?? 4599;
    client(cmd, port);
  }
}
