// skills/yarradev-run/scripts/runner/daemon.mjs
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
