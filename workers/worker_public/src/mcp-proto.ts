// The MCP protocol surface (JSON-RPC 2.0, streamable HTTP 2025-06-18),
// dependency-free so plain node can load it for unit tests — the
// route adapter (mcp.ts) owns the handler wiring.
export const PROTOCOL_VERSION = "2025-06-18";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[] };
}

export const TOOLS: McpTool[] = [
  {
    name: "ask",
    description: "Ask the corpus a question; returns a citation-grounded answer with the passages it rests on.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The question (1-8000 chars)" },
        lang: { type: "string", description: "Answer language hint (e.g. en, fr)" },
      },
      required: ["query"],
    },
  },
  {
    name: "retrieve",
    description: "Retrieve the top passages for a query (hybrid dense + metadata steering, reranked).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        k: { type: "number", description: "Hits to return (default 5)" },
      },
      required: ["query"],
    },
  },
];

export type McpResult =
  | { ok: true; result: unknown }
  | { ok: true; accepted: true }
  | { ok: false; code: number; message: string };

/** Dispatch one JSON-RPC request; `callTool` adapts a tool call to the
 *  real handlers (the route adapter's job). */
export function dispatch(
  method: string | null,
  params: any,
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<McpResult> {
  switch (method) {
    case "initialize":
      return Promise.resolve({ ok: true, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "rag", version: "1.0.0" } } });
    case "notifications/initialized":
    case "ping":
      return Promise.resolve({ ok: true, accepted: true });
    case "tools/list":
      return Promise.resolve({ ok: true, result: { tools: TOOLS } });
    case "tools/call": {
      const name = typeof params?.name === "string" ? params.name : "";
      if (!TOOLS.some((t) => t.name === name)) {
        return Promise.resolve({ ok: false, code: -32602, message: `unknown tool: ${name}` });
      }
      return callTool(name, params?.arguments ?? {}).then(
        (payload) => ({ ok: true, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }) as McpResult,
      );
    }
    default:
      return Promise.resolve({ ok: false, code: -32601, message: `method not found: ${method}` });
  }
}
