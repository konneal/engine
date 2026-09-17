// The MCP dispatcher's protocol surface — initialize, tools/list,
// notifications, and the JSON-RPC error contract. The tool-call paths
// exercise the real handlers and live in e2e, not here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch, TOOLS, PROTOCOL_VERSION } from "../workers/worker_public/src/mcp-proto.ts";

const call = (body: unknown) => dispatch((body as any)?.method ?? null, (body as any)?.params, async () => ({}));

test("initialize reports the protocol version and tools capability", async () => {
  const b = (await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })) as any;
  assert.equal(b.ok, true);
  assert.equal(b.result.protocolVersion, PROTOCOL_VERSION);
  assert.ok(b.result.capabilities.tools);
  assert.ok(b.result.serverInfo.name);
});

test("tools/list exposes ask and retrieve with schemas", async () => {
  const b = (await call({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as any;
  assert.deepEqual(
    (b.result.tools as typeof TOOLS).map((t) => t.name),
    ["ask", "retrieve"],
  );
  for (const t of TOOLS) {
    assert.equal(t.inputSchema.type, "object");
    assert.ok(t.inputSchema.required.includes("query"));
  }
});

test("notifications and ping are accepted without a payload", async () => {
  for (const method of ["notifications/initialized", "ping"]) {
    const r = (await call({ jsonrpc: "2.0", method })) as any;
    assert.ok(r.ok && "accepted" in r);
  }
});

test("unknown methods fail with -32601; unknown tools with -32602", async () => {
  const e = (await call({ jsonrpc: "2.0", id: 3, method: "no/such" })) as any;
  assert.equal(e.code, -32601);
  const t = (await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } })) as any;
  assert.equal(t.code, -32602);
});

test("a tool call wraps the handler payload as text content", async () => {
  const r = (await dispatch("tools/call", { name: "ask", arguments: { query: "x" } }, async () => ({ answer: "a", citations: [] }))) as any;
  assert.ok(r.ok);
  assert.equal(r.result.content[0].type, "text");
  assert.equal(JSON.parse(r.result.content[0].text).answer, "a");
});
