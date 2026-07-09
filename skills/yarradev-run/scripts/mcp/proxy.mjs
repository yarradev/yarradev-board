// skills/yarradev-run/scripts/mcp/proxy.mjs
const GET = new Set(["status", "inflight", "recent", "logs", "explain", "attention"]);

export function route(name, args = {}) {
  const method = GET.has(name) ? "GET" : "POST";
  let path = `/${name}`;
  if (name === "logs" && args.id != null) path += `?id=${encodeURIComponent(args.id)}`;
  if ((name === "explain" || name === "retry") && args.card != null) path += `?card=${encodeURIComponent(args.card)}`;
  return { method, path };
}

export async function makeCall({ port, fetchImpl } = {}) {
  let p = port;
  if (p == null) {
    const { loadConfig } = await import("../plugin-io.mjs");
    p = loadConfig().runner?.port ?? 4599;
  }
  const doFetch = fetchImpl ?? fetch;
  return async (name, args) => {
    const { method, path } = route(name, args);
    let res;
    try { res = await doFetch(`http://127.0.0.1:${p}${path}`, { method }); }
    catch (e) { throw new Error(`runner not reachable on 127.0.0.1:${p} — is 'yarradev run' running? (${String(e?.message ?? e)})`); }
    if (!res.ok) throw new Error(`control plane ${path} → HTTP ${res.status}`);
    return res.json();
  };
}
