// MCP server (streamable HTTP transport) exposing the OIML public corpus
// to MCP clients: tools oiml_search and oiml_ask, proxied to the rag-public
// API. Audience isolation stays enforced in rag-public (this worker holds
// no index bindings and no secrets beyond an optional API key).
//
// Protocol: JSON-RPC 2.0 over POST /mcp (Streamable HTTP). Stateless
// server — each request is answered in one JSON response; no sessions.
// https://modelcontextprotocol.io spec (2025-06 streamable HTTP).

export interface Env {
  RAG_BASE: string;
  RAG_API_KEY?: string;
  /** read-only access to the derived documents registry (public OIML
   *  metadata: editions, active flags, supersession) */
  DB: D1Database;
}

const PROTOCOL_VERSION = "2025-06-18";

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });

const rpcResult = (id: unknown, result: unknown) => json({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) =>
  json({ jsonrpc: "2.0", id, error: { code, message } });

const TOOLS = [
  {
    name: "oiml_search",
    description:
      "Search the OIML publications corpus (legal metrology: Recommendations R, Documents D, Basic publications B, Guides G). Returns ranked passages with publication identifier, edition, clause and snippet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Natural-language search query" },
        top_k: { type: "integer", description: "Number of passages (default 5, max 10)", default: 5 },
      },
      required: ["query"],
    },
  },
  {
    name: "oiml_documents",
    description:
      "Look up the publication registry for an OIML family: every edition with its derived status (in-force/superseded), which edition is ACTIVE (terminal of the successor chain), and supersession links. Use for 'current/latest edition' and edition-history questions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        family: { type: "string", description: "Family key, e.g. 'R-60' (series letter-number)" },
      },
      required: ["family"],
    },
  },
  {
    name: "oiml_ask",
    description:
      "Ask a question about OIML publications and get a grounded, citation-linked answer. Every claim cites the exact publication and clause it comes from.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "The question" },
        fresh: { type: "boolean", description: "Skip the answer cache and regenerate from the live corpus (default false)" },
      },
      required: ["query"],
    },
  },
];

async function rag(env: Env, path: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${env.RAG_BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(env.RAG_API_KEY ? { authorization: `Bearer ${env.RAG_API_KEY}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`rag-public ${path} → ${res.status}`);
  return res.json();
}

function searchResultText(r: any): string {
  const anchor = r.clause_anchor && r.clause_anchor !== "overview" ? ` §${r.clause_anchor}` : "";
  return `${r.docidentifier ?? r.doc_id}${r.edition ? ":" + r.edition : ""}${anchor}${r.clause_title ? " — " + r.clause_title : ""}\n${r.snippet ?? ""}`;
}

async function callTool(env: Env, name: string, args: any): Promise<{ content: Array<{ type: string; text: string }> }> {
  if (name === "oiml_search") {
    const query = String(args?.query ?? "").slice(0, 2000);
    if (!query) throw new Error("query is required");
    const data = await rag(env, "/api/search", { query, top_k: Math.min(10, Math.max(1, Number(args?.top_k) || 5)) });
    const text = (data.results ?? []).map(searchResultText).join("\n\n") || "No passages matched.";
    return { content: [{ type: "text", text }] };
  }
  if (name === "oiml_documents") {
    const family = String(args?.family ?? "").trim().slice(0, 20);
    if (!/^[A-Z]-\d{1,3}$/i.test(family)) throw new Error("family must look like 'R-60'");
    const rows = await env.DB.prepare(
      "SELECT d.docidentifier, d.derived_status, d.active, s.docidentifier AS succ FROM documents d LEFT JOIN documents s ON d.superseded_by = s.canonical_id WHERE d.family = ?1 ORDER BY d.part, d.edition",
    )
      .bind(family.toUpperCase())
      .all();
    const lines = (rows.results ?? []).map(
      (r: any) => `${r.docidentifier} — ${r.derived_status}${r.active ? " [ACTIVE]" : ""}${r.succ ? ` → superseded by ${r.succ}` : ""}`,
    );
    return { content: [{ type: "text", text: lines.join("\n") || `No editions found for ${family}` }] };
  }
  if (name === "oiml_ask") {
    const query = String(args?.query ?? "").slice(0, 2000);
    if (!query) throw new Error("query is required");
    const data = await rag(env, "/api/ask", { query, stream: false, ...(args?.fresh ? { fresh: true } : {}) });
    const cites = (data.citations ?? [])
      .map((c: any) => `${c.docidentifier}${c.clause_anchor ? " §" + c.clause_anchor : ""}`)
      .join(", ");
    const text = `${data.answer ?? ""}${cites ? `\n\nSources: ${cites}` : ""}`;
    return { content: [{ type: "text", text }] };
  }
  throw new Error(`Unknown tool: ${name}`);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/") {
      return json({
        server: "rag-mcp",
        transport: "streamable-http",
        endpoint: "/mcp",
        tools: TOOLS.map((t) => t.name),
      });
    }

    if (url.pathname !== "/mcp") return json({ error: "not_found" }, 404);
    if (req.method !== "POST") return json({ error: "method_not_allowed — POST JSON-RPC to /mcp" }, 405);

    let msg: any;
    try {
      msg = await req.json();
    } catch {
      return rpcError(null, -32700, "Parse error");
    }

    // notification (no id) — acknowledge with 202, nothing to say
    if (msg?.id === undefined || msg?.id === null) return new Response(null, { status: 202 });

    try {
      switch (msg.method) {
        case "initialize":
          return rpcResult(msg.id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "rag-mcp", version: "1.0.0", title: "OIML SMART AI — public corpus" },
          });
        case "tools/list":
          return rpcResult(msg.id, { tools: TOOLS });
        case "tools/call": {
          const out = await callTool(env, String(msg.params?.name ?? ""), msg.params?.arguments ?? {});
          return rpcResult(msg.id, out);
        }
        case "ping":
          return rpcResult(msg.id, {});
        default:
          return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
      }
    } catch (e: any) {
      return rpcResult(msg.id, {
        content: [{ type: "text", text: `Error: ${String(e?.message ?? e)}` }],
        isError: true,
      });
    }
  },
};
