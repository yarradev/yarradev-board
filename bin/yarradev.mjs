#!/usr/bin/env node
import { loadConfig, makeClient } from "../skills/yarradev-run/scripts/plugin-io.mjs";
import { createDaemon, spawnPass, startSources } from "../skills/yarradev-run/scripts/runner/daemon.mjs";
import { createControlPlane } from "../skills/yarradev-run/scripts/runner/control-plane.mjs";
import { buildStatus, inflightRows, assembleBoard } from "../skills/yarradev-run/scripts/runner/state.mjs";
import { manifestPath, resolveHome, stateDir } from "../skills/yarradev-run/scripts/runner/paths.mjs";
import { readBreaker, computeNextTickAt, readVerdict, explainCard, attentionCards, retryCard } from "../skills/yarradev-run/scripts/runner/providers.mjs";
import { renderBoard } from "../skills/yarradev-run/scripts/runner/render-board.mjs";
import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function buildActions({ daemon, client, humanClient, stopSources, getServer }) {
  return {
    pause: () => { daemon.pause(); return { ok: true, paused: true }; },
    resume: () => { daemon.resume(); return { ok: true, paused: false }; },
    tick: () => { daemon.requestTick(); return { ok: true }; },
    retry: (params) => retryCard(params?.get?.("card"), { client, requestTick: () => daemon.requestTick() }),
    // Human-gate act: answer a card's open question (ANSWER, gen-exempt) under the human identity.
    // Attempt-and-surface — a rejected act (no human token → 403) returns ok:false, never throws a 500.
    answer: async (params) => {
      const cardId = params?.get?.("card");
      const text = params?.get?.("text") || "Resume the card.";
      if (!cardId) return { ok: false, reason: "no card" };
      try {
        const r = await humanClient.answer(cardId, text);
        return { ok: r?.outcome === "committed", outcome: r?.outcome ?? null, status: r?.status ?? null, reason: r?.reason ?? null, cardId: String(cardId) };
      } catch (e) {
        return { ok: false, outcome: "error", reason: String(e?.message ?? e), cardId: String(cardId) };
      }
    },
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
export function buildProvider({ daemon, config, env, client }) {
  const staleS = Number(config.runtime?.inflightStaleS ?? 7200);
  const intervalMs = (config.pace?.minLoopIntervalS ?? 300) * 1000;
  const sdir = stateDir(env);
  const read = () => { try { return readFileSync(manifestPath(env), "utf8"); } catch { return ""; } };
  return {
    status: async () => buildStatus({
      paused: daemon.isPaused(), intervalMs, lastTick: daemon.lastTick(),
      nextTickAt: computeNextTickAt(daemon.lastTick(), intervalMs),
      breaker: readBreaker(sdir), passRunning: daemon.passRunning(), now: Date.now(),
    }),
    inflight: () => inflightRows(read(), Date.now(), staleS),
    board: () => assembleBoard({ activityMap: daemon.getActivity?.() ?? new Map(), manifestContent: read(), now: Date.now(), staleS }),
    recent: () => [daemon.lastTick()].filter(Boolean),
    attention: () => attentionCards({ client }),
    // No usable `claude -p` usage signal exists: claudeArgs (see daemon.mjs/pass.mjs) never passes
    // --output-format json, so there is nothing to parse a token/cost count out of. Documented stub —
    // do NOT fabricate cost data here.
    cost: () => ({ available: false, reason: "claude -p usage is not captured (no --output-format json); cost is best-effort and unavailable in this version" }),
    logs: (id) => readVerdict(read(), id),
    explain: (card) => explainCard(card, { client, manifestContent: read(), stateDir: sdir }),
  };
}

async function run(env = process.env) {
  const home = resolveHome(env);
  const passPath = join(home, "skills", "yarradev-run", "scripts", "pass.mjs");
  const config = loadConfig();
  const intervalMs = (config.pace?.minLoopIntervalS ?? 300) * 1000;
  const runPass = () => spawnPass({ passPath, env: { ...env, YARRADEV_HOME: home }, timeoutMs: (config.runner?.passTimeout ?? 120) * 1000 });
  const daemon = createDaemon({ runPass, intervalMs });
  // Named boardClient (not `client`) to avoid shadowing the module-level CLI helper `client(cmd, port)`
  // used by the thin-client dispatch below (#69.4).
  const boardClient = makeClient({ role: "orchestrator" });
  // Human identity for human-gate acts posted from the dashboard (ANSWER). resolveToken("human") →
  // YDB_TOKEN_HUMAN, falling back to the shared YDB_TOKEN; a 403 is surfaced by the action, not fatal.
  const humanClient = makeClient({ role: "human" });
  // Touch the manifest file BEFORE startSources() so fs.watch() attaches on a fresh machine (see
  // ensureManifestFile's docstring) — otherwise the watch silently never activates.
  ensureManifestFile(env);
  const stopSources = startSources(daemon, { manifestFile: manifestPath(env), intervalMs, debounceMs: config.runner?.debounceMs ?? 750 });
  let server;
  const actions = buildActions({ daemon, client: boardClient, humanClient, stopSources, getServer: () => server });
  server = createControlPlane({ provider: buildProvider({ daemon, config, env, client: boardClient }), actions });
  const port = config.runner?.port ?? 4599;
  server.listen(port, "127.0.0.1", () => process.stderr.write(`yarradev-run: control plane on http://127.0.0.1:${port}\n`));
  daemon.requestTick(); // first pass immediately
}

// Read routes the control plane serves as GET (control-plane.mjs:15-21); everything else is POST.
// Mirrors the runner MCP proxy's route table (mcp/proxy.mjs) so the CLI and MCP agree on method+params.
export const GET = new Set(["status", "logs", "inflight", "recent", "attention", "explain", "cost", "board"]);
// "watch" is deliberately NOT in GET: it's a client-side poll loop over GET /board, not a
// control-plane route in its own right (control-plane.mjs has no /watch handler).
export const COMMANDS = new Set([...GET, "pause", "resume", "tick", "retry", "stop", "watch"]);

/** Build the control-plane URL, forwarding a card id as the query param the route expects (#72.2):
 *  logs → ?id=<card>; explain/retry → ?card=<card>. Other routes ignore the extra arg. */
export function clientUrl(cmd, port, arg) {
  let path = `/${cmd}`;
  if (arg != null && arg !== "") {
    if (cmd === "logs") path += `?id=${encodeURIComponent(arg)}`;
    else if (cmd === "explain" || cmd === "retry") path += `?card=${encodeURIComponent(arg)}`;
  }
  return `http://127.0.0.1:${port}${path}`;
}

const USAGE = `usage: yarradev <command> [card]
  run                        start the runner daemon (control plane + tick loop)
  status                     paused / interval / last+next tick / breaker
  inflight                   cards dispatched and unresolved
  recent                     the most recent tick outcome
  attention                  cards awaiting a human (veto/hold/open-question/escalated)
  cost                       best-effort cost (unavailable in this version)
  board                      print the live status board once (table, not raw JSON)
  watch [--interval <ms>]     live status board, redrawn (default 1000ms)
  logs <card>                streamed verdict/log text for a card's newest dispatch
  explain <card>             merged board + local + breaker view of a card
  pause | resume | tick      control the tick loop
  retry <card>               clear a stuck card's lease and request a tick
  stop                       stop the daemon`;

async function client(cmd, port, arg) {
  let r;
  try {
    r = await fetch(clientUrl(cmd, port, arg), { method: GET.has(cmd) ? "GET" : "POST" });
  } catch (e) {
    // No daemon (ECONNREFUSED) or other transport failure → friendly message, not an uncaught rejection (#72.3).
    const cause = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e;
    process.stderr.write(`runner not running — start it with \`kdbx run -- yarradev run\` (${cause})\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(await r.json(), null, 2) + "\n");
}

async function fetchBoard(port) {
  const res = await fetch(clientUrl("board", port), { method: "GET" });
  return res.json();
}

/** One-shot `board`: fetch /board, render it as a table, print, exit 0. Mirrors client()'s
 * ECONNREFUSED-friendly handling (friendly message + exit 1) instead of an uncaught rejection.
 * The render is inside the same try as the fetch (not just the fetch) — a reachable-but-wrong
 * server (e.g. an old daemon build with no /board route, replying 404 `{"error":"not found"}`)
 * doesn't make fetch() throw; renderBoard() throws instead on the non-array body, which must
 * still land on the friendly path, not an uncaught rejection with a raw stack trace. */
async function printBoardOnce(port) {
  try {
    const rows = await fetchBoard(port);
    process.stdout.write(renderBoard(rows, { color: process.stdout.isTTY }) + "\n");
  } catch (e) {
    const cause = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e;
    process.stderr.write(`runner not running — start it with \`kdbx run -- yarradev run\` (${cause})\n`);
    process.exit(1);
  }
}

/** Poll /board every intervalMs, clear the screen, redraw. Tolerates a daemon blip (keeps polling —
 * a daemon restart must not kill the watch loop; only SIGINT/SIGTERM end it). */
async function watch(port, intervalMs) {
  const color = process.stdout.isTTY;
  process.stdout.write("\x1b[?25l"); // hide cursor
  const restore = () => { process.stdout.write("\x1b[?25h"); process.exit(0); }; // show cursor on exit
  process.on("SIGINT", restore);
  process.on("SIGTERM", restore);
  for (;;) {
    let frame;
    try {
      const rows = await fetchBoard(port);
      frame = renderBoard(rows, { color }) + `\n\n  polling :${port} every ${intervalMs}ms — Ctrl-C to exit`;
    } catch (e) {
      const cause = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e;
      frame = `runner not reachable on :${port} (${cause}) — retrying…`;
    }
    process.stdout.write("\x1b[2J\x1b[H" + frame + "\n"); // clear screen + home, then draw
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2] ?? "run";
  if (cmd === "run") run();
  else if (cmd === "help" || cmd === "--help" || cmd === "-h") process.stdout.write(USAGE + "\n");
  else if (!COMMANDS.has(cmd)) {
    process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}\n`);
    process.exit(2);
  } else {
    const config = loadConfig();
    const port = config.runner?.port ?? 4599;
    if (cmd === "watch") {
      const i = process.argv.indexOf("--interval");
      const intervalMs = i !== -1 ? Number(process.argv[i + 1]) || 1000 : 1000;
      watch(port, intervalMs);
    } else if (cmd === "board") {
      printBoardOnce(port);
    } else {
      client(cmd, port, process.argv[3]);
    }
  }
}
