// skills/yarradev-run/scripts/runner/daemon.mjs
import { spawn as nodeSpawn } from "node:child_process";
import { watch as fsWatch } from "node:fs";

export function createDaemon({ runPass, intervalMs, now = () => Date.now() }) {
  let paused = false, inFlight = null, dirty = false, last = null;

  async function loop() {
    if (inFlight) { dirty = true; return inFlight; }
    inFlight = (async () => {
      do {
        dirty = false;
        try { const r = await runPass(); last = { at: now(), ok: !!r?.ok, verdicts: r?.verdicts ?? 0 }; }
        catch (e) { last = { at: now(), ok: false, error: String(e?.message ?? e) }; }
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
    async _drain() { while (inFlight) await inFlight; },
  };
}

export function spawnPass({ passPath, env, timeoutMs = 120_000, spawn = nodeSpawn }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [passPath], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d.toString(); });
    // Drain stderr so a chatty pass can't fill the pipe buffer and block the child; we don't
    // need its contents (verdicts are parsed from stdout only).
    child.stderr.on("data", () => {});
    // If spawn() itself fails to launch the process (EMFILE/ENOMEM/EACCES/ENOENT), Node emits
    // only 'error' — 'close' never fires — so without this handler the promise (and the
    // timeoutMs guard, which just kills an already-nonexistent process) hangs forever.
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, verdicts: 0, error: String(e?.message ?? e) });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // pass.mjs's reconcile lines carry a STRING `outcome` ("routed"|"skipped"|"dispatch_error"|
      // "no-parse"|"act_failed"|"error" — see reconcileVerdicts' results.push shape), never a numeric
      // `routed` field. Count one per successfully-routed verdict line.
      let verdicts = 0;
      for (const line of out.split("\n")) { try { const j = JSON.parse(line); if (j?.phase === "reconcile" && j.outcome === "routed") verdicts += 1; } catch {} }
      resolve({ ok: !killed && code === 0, verdicts, error: killed ? "pass timeout" : (code === 0 ? undefined : `exit ${code ?? signal}`) });
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
