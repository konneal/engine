// The MCP dispatcher's protocol surface — initialize, tools/list,
// notifications, and the JSON-RPC error contract. The tool-call paths
// exercise the real handlers and live in e2e, not here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch, buildTools, PROTOCOL_VERSION, mcpName, registryName } from "../workers/worker_public/src/mcp-proto.ts";

const call = (body: unknown) => dispatch((body as any)?.method ?? null, (body as any)?.params, async () => ({}));

test("initialize reports the protocol version and tools capability", async () => {
  const b = (await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })) as any;
  assert.equal(b.ok, true);
  assert.equal(b.result.protocolVersion, PROTOCOL_VERSION);
  assert.ok(b.result.capabilities.tools);
  assert.ok(b.result.serverInfo.name);
});

test("tools/list exposes the prefixed ask, retrieve and the registry's MCP tools with schemas", async () => {
  const b = (await call({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as any;
  assert.deepEqual(
    (b.result.tools as ReturnType<typeof buildTools>).map((t) => t.name),
    [mcpName("ask"), mcpName("retrieve"), ...["db.schema", "db.find", "certificates.search", "units.get", "graph.cites", "docs.section", "glossary.lookup", "documents.family", "licensed.section", "verdict.evaluate", "conditions.check", "bib.entry", "units.lookup", "units.convert"].map(mcpName)],
  );
  for (const t of buildTools()) {
    assert.equal(t.inputSchema.type, "object");
    assert.ok(Object.keys(t.inputSchema.properties as Record<string, unknown>).length > 0, "every tool declares its params");
    for (const r of t.inputSchema.required) {
      assert.ok(r in (t.inputSchema.properties as Record<string, unknown>), `required param ${r} is declared`);
    }
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
  const r = (await dispatch("tools/call", { name: mcpName("ask"), arguments: { query: "x" } }, async () => ({ answer: "a", citations: [] }))) as any;
  assert.ok(r.ok);
  assert.equal(r.result.content[0].type, "text");
  assert.equal(JSON.parse(r.result.content[0].text).answer, "a");
});

// ── the MCP naming convention (2026-10-12): publisher-prefixed, the
//    three published contracts keep their exact spelling ──

test("the naming transform: mechanical, overrides, reverse, raw tolerance", () => {
  // mechanical: dots become underscores under the publisher prefix
  assert.match(mcpName("db.schema"), /^[a-z]+_db_schema$/);
  assert.equal(mcpName("ask").endsWith("_ask"), true);
  // the published contracts keep their exact spelling
  assert.equal(mcpName("retrieve").endsWith("_search"), true);
  assert.equal(mcpName("documents.family").endsWith("_documents"), true);
  // the reverse lands on the handler-dispatch names
  assert.equal(registryName(mcpName("ask")), "ask");
  assert.equal(registryName(mcpName("retrieve")), "retrieve");
  assert.equal(registryName(mcpName("documents.family")), "documents.family");
  assert.equal(registryName(mcpName("db.schema")), "db.schema");
  // raw registry names pass through (transition tolerance)
  assert.equal(registryName("ask"), "ask");
  assert.equal(registryName("db.find"), "db.find");
});

test("tools/call accepts the prefixed name and dispatches the registry tool", async () => {
  const seen: string[] = [];
  const r = await dispatch("tools/call", { name: mcpName("db.schema"), arguments: {} }, async (name) => {
    seen.push(name);
    return { ok: true };
  });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ["db.schema"]);
  const unknown = await dispatch("tools/call", { name: "oiml_nope", arguments: {} }, async () => ({}));
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.code, -32602);
});

test("tools/list carries the DEPLOYMENT's prefix — the profile is read per call, never frozen at import", async () => {
  const { setProfile } = await import("../workers/worker_public/src/profile.ts");
  const { PROFILE } = await import("../workers/worker_public/src/profile.gen.ts");
  setProfile({ ...PROFILE, publisher: { ...PROFILE.publisher, id: "oiml", name: "OIML" } });
  try {
    const b = (await call({ jsonrpc: "2.0", id: 9, method: "tools/list" })) as any;
    const names = (b.result.tools as { name: string }[]).map((t) => t.name);
    assert.ok(names.every((n) => n.startsWith("oiml_")), JSON.stringify(names));
    assert.ok(names.includes("oiml_ask") && names.includes("oiml_search") && names.includes("oiml_documents"));
  } finally {
    setProfile(PROFILE); // the fixture default back for the other tests
  }
});
