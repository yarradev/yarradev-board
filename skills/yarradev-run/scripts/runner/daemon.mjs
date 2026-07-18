// skills/yarradev-run/scripts/runner/daemon.mjs
import { spawn as nodeSpawn } from "node:child_process";
import { watch as fsWatch } from "node:fs";
import { parsePassActivity, applyEvents, pruneActivity } from "./pass-activity.mjs";

export function createDaemon({ runPass, intervalMs, now = () => Date.now(), activityTtlMs = 600_000, activityCap = 50 }) {
  let paused = false, inFlight = null, dirty = false, last = null;
  const activity = new Map();

  async function loop() {
    if (inFlight) { dirty = true; return inFlight; }
    inFlight = (async () => {
      do {
        dirty = false;
        try {
          const r = await runPass();
          // #91: spawnPass RESOLVES { ok:false, error } on a failed pass — it does not throw — so the
          // catch below never sees it and the reason was dropped here. A non-zero exit surfaced as
          // ok:false with no explanation, with the explanation already in hand.
          last = { at: now(), ok: !!r?.ok, verdicts: r?.verdicts ?? 0, ...(r?.error ? { error: r.error } : {}) };
          if (Array.isArray(r?.events) && r.events.length) applyEvents(activity, r.events);
        } catch (e) { last = { at: now(), ok: false, error: String(e?.message ?? e) }; }
        pruneActivity(activity, now(), { ttlMs: activityTtlMs, cap: activityCap });
      } while (dirty && !paused);
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    requestTick() { if (!paused) return loop(); },
    pause() { paused = true; },
    resume() { paused = false; },
    isPaused: () => paused,
    passRunning: () => inFlight !== null,
    lastTick: () => last,
    getActivity: () => activity,
    async _drain() { while (inFlight) await inFlight; },
  };
}

/** #91: stderr can carry an Authorization header, a token in a URL, or an env dump, and the captured text
 * reaches lastTick.error → the runner MCP `status` tool → agent transcripts and logs. Scrub the known
 * shapes before storing. Best-effort by construction: this bounds the blast radius of the common cases,
 * it is not a guarantee that no secret can ever appear — which is why the capture is also size-bounded
 * and why full detail belongs in the pass's own stderr, not in status. */
export function redactSecrets(s) {
  return String(s)
    .replace(/(Bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/\b(YDB_TOKEN[A-Z0-9_]*|ANTHROPIC_API_KEY|GITHUB_TOKEN|GH_TOKEN)\s*[=:]\s*\S+/gi, "$1=[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{10,}/g, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9-]{10,}/g, "[redacted]")
    .replace(/([?&](?:token|key|access_token|api_key)=)[^&\s]+/gi, "$1[redacted]");
}

const STDERR_CAPTURE_MAX = 4000; // accumulated
const STDERR_EMIT_MAX = 2000; // attached to the error

export function spawnPass({ passPath, env, timeoutMs = 120_000, spawn = nodeSpawn }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [passPath], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let killed = false; let errOut = "";
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d.toString(); });
    // #91: capture a BOUNDED prefix of stderr for diagnostics on failure. The drain is load-bearing and
    // stays — a chatty pass must not fill the pipe buffer and block the child — but draining and keeping
    // a capped prefix are not in conflict. Verdicts are still parsed from stdout only.
    child.stderr.on("data", (d) => { if (errOut.length < STDERR_CAPTURE_MAX) errOut += d.toString(); });
    // If spawn() itself fails to launch the process (EMFILE/ENOMEM/EACCES/ENOENT), Node emits
    // only 'error' — 'close' never fires — so without this handler the promise (and the
    // timeoutMs guard, which just kills an already-nonexistent process) hangs forever.
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, verdicts: 0, events: [], error: String(e?.message ?? e) });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // pass.mjs's reconcile lines carry a STRING `outcome` ("routed"|"skipped"|"dispatch_error"|
      // "no-parse"|"act_failed"|"error" — see reconcileVerdicts' results.push shape), never a numeric
      // `routed` field. Count one per successfully-routed verdict line.
      let verdicts = 0;
      for (const line of out.split("\n")) { try { const j = JSON.parse(line); if (j?.phase === "reconcile" && j.outcome === "routed") verdicts += 1; } catch {} }
      const events = parsePassActivity(out, Date.now());
      // #91: on a non-zero exit, attach the (redacted, bounded) stderr tail — that is the difference
      // between `status` saying "exit 1" and saying "429 Weekly/Monthly Limit Exhausted". A timeout keeps
      // its own "pass timeout" reason: the child was killed mid-flight, so its stderr describes the work
      // in progress, not the failure.
      const detail = redactSecrets(errOut).trim().slice(0, STDERR_EMIT_MAX);
      resolve({
        ok: !killed && code === 0,
        verdicts,
        events,
        error: killed ? "pass timeout" : (code === 0 ? undefined : `exit ${code ?? signal}${detail ? `: ${detail}` : ""}`),
      });
    });
  });
}

export function startSources(daemon, { manifestFile, intervalMs, debounceMs = 750, watch = fsWatch, setInterval: si = setInterval }) {
  let deb = null;
  const onChange = () => { clearTimeout(deb); deb = setTimeout(() => daemon.requestTick(), debounceMs); };
  let watcher; try { watcher = watch(manifestFile); watcher?.on?.("change", onChange); } catch { watcher = null; }
  const iv = si(() => daemon.requestTick(), intervalMs);
  return () => { clearTimeout(deb); watcher?.close?.(); clearInterval(iv); };
}
