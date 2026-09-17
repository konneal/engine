// The public-audience MCP server (streamable HTTP): the same
// ask/retrieve surfaces as /v1, behind the same API-key tiering, for
// agent ecosystems. A thin adapter by design — each tool call is an
// internal Request to the exported route handler, so MCP can never
// drift from the API contract; the protocol dispatch lives in
// mcp-proto.ts (dependency-free, unit-tested). The internal-audience
// server federates both indexes and lives with worker_internal.
import { json, readJson, type ApiKey } from "./lib/http";
import { P } from "./profile.ts";
import { dispatch } from "./mcp-proto.ts";
import type { Env } from "./env.ts";

export async function handleMcp(
  env: Env,
  ctx: ExecutionContext,
  req: Request,
  tier: "anon" | "key" | "member",
  key: ApiKey | null,
): Promise<Response> {
  const body = await readJson(req);
  const method = typeof body?.method === "string" ? body.method : null;
  const id = body?.id ?? null;

  const out = await dispatch(method, body?.params, async (name, args) => {
    const inner = new Request("https://internal/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // stream:false forces the JSON lane (anon defaults to SSE)
      body: JSON.stringify({ ...args, stream: false }),
    });
    // deferred so plain node can load mcp-proto without the handlers'
    // .md prompt imports, which only the bundler resolves
    const res = name === "ask"
      ? await (await import("./ask")).handleAsk(env, ctx, inner, tier, key)
      : await (await import("./search")).handleSearch(env, ctx, inner, tier, key);
    return res.json().catch(() => ({ error: { message: "tool transport failed", status: res.status } }));
  });

  if (out.ok && "accepted" in out) return new Response(null, { status: 202 });
  if (out.ok) {
    if ((out.result as any)?.serverInfo) (out.result as any).serverInfo.name = `${P().publisher.id}-rag`;
    return json({ jsonrpc: "2.0", id, result: out.result });
  }
  return json({ jsonrpc: "2.0", id, error: { code: out.code, message: out.message } });
}
