import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "monitor.html"), "utf8");

export function createControlPlane({ provider, actions }) {
  const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const p = url.pathname;
    try {
      if (req.method === "GET" && p === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(HTML); }
      if (req.method === "GET" && p === "/status") return json(res, 200, await provider.status());
      if (req.method === "GET" && p === "/inflight") return json(res, 200, await provider.inflight());
      if (req.method === "GET" && p === "/recent") return json(res, 200, await provider.recent());
      if (req.method === "GET" && p === "/attention") return json(res, 200, await provider.attention());
      if (req.method === "GET" && p === "/cost") return json(res, 200, await provider.cost());
      if (req.method === "GET" && p === "/board") return json(res, 200, await provider.board());
      if (req.method === "GET" && p === "/logs") return json(res, 200, { text: await provider.logs(url.searchParams.get("id")) });
      if (req.method === "GET" && p === "/explain") return json(res, 200, await provider.explain(url.searchParams.get("card")));
      // control routes wired in Task 10
      if (req.method === "POST" && actions[p.slice(1)]) return json(res, 200, await actions[p.slice(1)](url.searchParams));
      json(res, 404, { error: "not found" });
    } catch (e) { json(res, 500, { error: String(e?.message ?? e) }); }
  });
}
