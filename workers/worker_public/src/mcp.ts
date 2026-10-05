// The public-audience MCP server (streamable HTTP): the same
// ask/retrieve surfaces as /v1, behind the same API-key tiering, for
// agent ecosystems. A thin adapter by design — each tool call is an
// internal Request to the exported route handler, so MCP can never
// drift from the API contract; the protocol dispatch lives in
// mcp-proto.ts (dependency-free, unit-tested). The internal-audience
// server federates both indexes and lives in its own worker, never here.
import { json, readJson, type ApiKey } from "./lib/http";
import { sha256Hex } from "./config.ts";
import { telemetry } from "./quota.ts";
import { P } from "./profile.ts";
import { dispatch } from "./mcp-proto.ts";
import type { Env } from "./env.ts";
import type { Background } from "./ports/runtime.ts";

export async function handleMcp(
  env: Env,
  // the port type, not the provider token — the handlers cast at their edge
  ctx: Background,
  req: Request,
  tier: "anon" | "key" | "member",
  key: ApiKey | null,
): Promise<Response> {
  const body = await readJson(req);
  const method = typeof body?.method === "string" ? body.method : null;
  const id = body?.id ?? null;

  const out = await dispatch(method, body?.params, async (name, args) => {
    const t0 = Date.now();
    try {
      return await callToolOnce(env, ctx, req, tier, key, name, args, t0);
    } catch (e) {
      telemetry(env, ctx, tier, `mcp:${name}`, null, false, 0, await sha256Hex(`${name}:${JSON.stringify(args ?? {})}`), undefined, undefined, { durationMs: Date.now() - t0 });
      throw e;
    }
  });

  if (out.ok && "accepted" in out) return new Response(null, { status: 202 });
  if (out.ok) {
    if ((out.result as any)?.serverInfo) (out.result as any).serverInfo.name = `${P().publisher.id}-rag`;
    return json({ jsonrpc: "2.0", id, result: out.result });
  }
  return json({ jsonrpc: "2.0", id, error: { code: out.code, message: out.message } });
}

/** One tools/call dispatch, measured: every MCP surface's tool usage
 *  lands in the queries table under the mcp:<tool> route — which tools
 *  agents actually call becomes countable, per tier, per key. */
async function callToolOnce(
  env: Env,
  ctx: Background,
  _req: Request,
  tier: "anon" | "key" | "member",
  key: ApiKey | null,
  name: string,
  args: Record<string, unknown>,
  t0: number,
) {
  {
    const inner = new Request("https://internal/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // stream:false forces the JSON lane (anon defaults to SSE)
      body: JSON.stringify({ ...args, stream: false }),
    });
    // deferred so plain node can load mcp-proto without the handlers'
    // .md prompt imports, which only the bundler resolves
    // registry tools (certificates.search, units.get, …) dispatch through
    // the SAME handlers the API would — the no-drift rule, now structural
    const { runTool, TOOLS_REGISTRY } = await import("./tools.ts");
    if (TOOLS_REGISTRY.some((t) => t.name === name && t.audiences.includes("mcp"))) {
      const r = await runTool({ ...env, DB: (env as any).DB }, { name, args }, "mcp");
      return r ? { tool: r.name, query: r.query, result: r.output } : { error: { message: `tool ${name} returned nothing for the given arguments` } };
    }
    const res = name === "ask"
      ? await (await import("./ask")).handleAsk(env, ctx as any, inner, tier, key)
      : await (await import("./search")).handleSearch(env, ctx as any, inner, tier, key);
    const payload: any = await res.json().catch(() => ({ error: { message: "tool transport failed", status: res.status } }));
    telemetry(env, ctx, tier, `mcp:${name}`, null, !payload?.error, JSON.stringify(payload).length, await sha256Hex(`${name}:${JSON.stringify(args ?? {})}`), undefined, undefined, { durationMs: Date.now() - t0 });
    return payload;
  }
}
