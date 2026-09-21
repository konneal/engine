import {
  authenticate
} from "../../chunk-EFQALN2Z.js";
import "../../chunk-ADXV2DPK.js";
import {
  P,
  setProfile
} from "../../chunk-TJRTVJW5.js";

// workers/worker_mcp/src/index.ts
var PROTOCOL_VERSION = "2025-06-18";
var json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", ...extra }
});
var rpcResult = (id, result) => json({ jsonrpc: "2.0", id, result });
var rpcError = (id, code, message) => json({ jsonrpc: "2.0", id, error: { code, message } });
var publisherId = () => P().publisher.id;
var bearer = (req) => (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
var publisherName = () => P().publisher.name;
var tools = () => [
  {
    name: `${publisherId()}_search`,
    description: `Search the ${publisherName()} publications corpus. Returns ranked passages with publication identifier, edition, clause and snippet.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query" },
        top_k: { type: "integer", description: "Number of passages (default 5, max 10)", default: 5 }
      },
      required: ["query"]
    }
  },
  {
    name: `${publisherId()}_documents`,
    description: `Look up the publication registry for a ${publisherName()} family: every edition with its derived status (in-force/superseded), which edition is ACTIVE (terminal of the successor chain), and supersession links. Use for 'current/latest edition' and edition-history questions.`,
    inputSchema: {
      type: "object",
      properties: {
        family: { type: "string", description: "Family key, e.g. 'R-60' (series letter-number)" }
      },
      required: ["family"]
    }
  },
  {
    name: `${publisherId()}_ask`,
    description: `Ask a question about ${publisherName()} publications and get a grounded, citation-linked answer. Every claim cites the exact publication and clause it comes from.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The question" },
        fresh: { type: "boolean", description: "Skip the answer cache and regenerate from the live corpus (default false)" }
      },
      required: ["query"]
    }
  }
];
async function rag(env, auth, path, body) {
  const res = await fetch(`${env.RAG_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`rag-public ${path} \u2192 ${res.status}`);
  return res.json();
}
function searchResultText(r) {
  const anchor = r.clause_anchor && r.clause_anchor !== "overview" ? ` \xA7${r.clause_anchor}` : "";
  return `${r.docidentifier ?? r.doc_id}${r.edition ? ":" + r.edition : ""}${anchor}${r.clause_title ? " \u2014 " + r.clause_title : ""}
${r.snippet ?? ""}`;
}
async function callTool(env, auth, name, args) {
  if (name === `${publisherId()}_search`) {
    const query = String(args?.query ?? "").slice(0, 2e3);
    if (!query) throw new Error("query is required");
    const data = await rag(env, auth, "/api/search", { query, top_k: Math.min(10, Math.max(1, Number(args?.top_k) || 5)) });
    const text = (data.results ?? []).map(searchResultText).join("\n\n") || "No passages matched.";
    return { content: [{ type: "text", text }] };
  }
  if (name === `${publisherId()}_documents`) {
    const family = String(args?.family ?? "").trim().slice(0, 20);
    if (!/^[A-Z]-\d{1,3}$/i.test(family)) throw new Error("family must look like 'R-60'");
    const rows = await env.DB.prepare(
      "SELECT d.docidentifier, d.derived_status, d.active, s.docidentifier AS succ FROM documents d LEFT JOIN documents s ON d.superseded_by = s.canonical_id WHERE d.family = ?1 ORDER BY d.part, d.edition"
    ).bind(family.toUpperCase()).all();
    const lines = (rows.results ?? []).map(
      (r) => `${r.docidentifier} \u2014 ${r.derived_status}${r.active ? " [ACTIVE]" : ""}${r.succ ? ` \u2192 superseded by ${r.succ}` : ""}`
    );
    return { content: [{ type: "text", text: lines.join("\n") || `No editions found for ${family}` }] };
  }
  if (name === `${publisherId()}_ask`) {
    const query = String(args?.query ?? "").slice(0, 2e3);
    if (!query) throw new Error("query is required");
    const data = await rag(env, auth, "/api/ask", { query, stream: false, ...args?.fresh ? { fresh: true } : {} });
    const cites = (data.citations ?? []).map((c) => `${c.docidentifier}${c.clause_anchor ? " \xA7" + c.clause_anchor : ""}`).join(", ");
    const text = `${data.answer ?? ""}${cites ? `

Sources: ${cites}` : ""}`;
    return { content: [{ type: "text", text }] };
  }
  throw new Error(`Unknown tool: ${name}`);
}
var src_default = {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") {
      return json({
        server: "rag-mcp",
        transport: "streamable-http",
        endpoint: "/mcp",
        tools: tools().map((t) => t.name)
      });
    }
    if (url.pathname !== "/mcp") return json({ error: "not_found" }, 404);
    if (req.method !== "POST") return json({ error: "method_not_allowed \u2014 POST JSON-RPC to /mcp" }, 405);
    const key = await authenticate(env, req);
    if (!key) return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized: configure this MCP server with an API key (Authorization: Bearer <key>)" } }, 401);
    let msg;
    try {
      msg = await req.json();
    } catch {
      return rpcError(null, -32700, "Parse error");
    }
    if (msg?.id === void 0 || msg?.id === null) return new Response(null, { status: 202 });
    try {
      switch (msg.method) {
        case "initialize":
          return rpcResult(msg.id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "rag-mcp", version: "1.0.0", title: `${P().publisher.product_name} \u2014 public corpus` }
          });
        case "tools/list":
          return rpcResult(msg.id, { tools: tools() });
        case "tools/call": {
          const out = await callTool(env, bearer(req), String(msg.params?.name ?? ""), msg.params?.arguments ?? {});
          return rpcResult(msg.id, out);
        }
        case "ping":
          return rpcResult(msg.id, {});
        default:
          return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
      }
    } catch (e) {
      return rpcResult(msg.id, {
        content: [{ type: "text", text: `Error: ${String(e?.message ?? e)}` }],
        isError: true
      });
    }
  }
};
export {
  src_default as default,
  setProfile
};
