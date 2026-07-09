// skills/yarradev-run/scripts/mcp/server.mjs
const S = { type: "object", properties: {}, additionalProperties: false };
const CARD = { type: "object", properties: { card: { type: "string", description: "card id" } }, required: ["card"], additionalProperties: false };
const ID = { type: "object", properties: { id: { type: "string", description: "card id" } }, required: ["id"], additionalProperties: false };

export const TOOLS = [
  { name: "status",    description: "Runner status: paused, interval, last/next tick, breaker, pass running.", inputSchema: S },
  { name: "inflight",  description: "Cards currently dispatched and unresolved (role, age).", inputSchema: S },
  { name: "recent",    description: "The most recent tick outcome.", inputSchema: S },
  { name: "logs",      description: "The streamed verdict/log text for a card's newest dispatch.", inputSchema: ID },
  { name: "explain",   description: "Merged board + local (dispatch/verdict) + breaker view of a card.", inputSchema: CARD },
  { name: "attention", description: "Cards awaiting a human (veto/hold/open-question/escalated).", inputSchema: S },
  { name: "pause",     description: "Pause the tick loop.", inputSchema: S },
  { name: "resume",    description: "Resume the tick loop.", inputSchema: S },
  { name: "tick",      description: "Request one reconciliation pass now.", inputSchema: S },
  { name: "retry",     description: "Clear a stuck card's lease and request a tick (never crosses a human gate).", inputSchema: CARD },
];

const PROTOCOL_VERSION = "2024-11-05";
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

export async function handleMessage(msg, { call }) {
  if (msg?.id == null && typeof msg?.method === "string") return null; // notification
  const { id, method, params } = msg ?? {};
  if (method === "initialize")
    return ok(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "yarradev-runner", version: "1.0.0" } });
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    if (!TOOLS.some((t) => t.name === name)) return err(id, -32601, `unknown tool: ${name}`);
    try {
      const result = await call(name, params?.arguments ?? {});
      return ok(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (e) {
      return ok(id, { isError: true, content: [{ type: "text", text: `error calling ${name}: ${String(e?.message ?? e)}` }] });
    }
  }
  return err(id, -32601, `method not found: ${method}`);
}

// stdio loop (only when run directly) — wired to the HTTP proxy in Task B2
if (import.meta.url === `file://${process.argv[1]}`) {
  const { createInterface } = await import("node:readline");
  const { makeCall } = await import("./proxy.mjs"); // Task B2
  const call = await makeCall();
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    const t = line.trim(); if (!t) return;
    let msg; try { msg = JSON.parse(t); } catch { return; }
    const res = await handleMessage(msg, { call });
    if (res) process.stdout.write(JSON.stringify(res) + "\n");
  });
}
