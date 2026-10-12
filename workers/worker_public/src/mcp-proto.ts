// The MCP protocol surface (JSON-RPC 2.0, streamable HTTP 2025-06-18),
// dependency-free so plain node can load it for unit tests — the
// route adapter (mcp.ts) owns the handler wiring.
import { TOOLS_REGISTRY } from "./tools.ts";
import { P } from "./profile.ts";
export const PROTOCOL_VERSION = "2025-06-18";

// The MCP naming convention (2026-10-12): every tool the publisher
// exposes over MCP carries the publisher prefix — MCP clients render
// tool names in a SHARED namespace, so generic names ("ask") collide
// across servers. The three names docs/MCP.md already publishes keep
// their exact spelling; the mechanical transform covers the rest.
const mcpPrefix = () => `${P().publisher.id}_`;
const MCP_NAME_OVERRIDES: Record<string, string> = {
  retrieve: `${P().publisher.id}_search`,          // the published retrieval contract
  "documents.family": `${P().publisher.id}_documents`, // the published registry contract
};

/** Registry tool name → the MCP-presented name. */
export function mcpName(registryName: string): string {
  return MCP_NAME_OVERRIDES[registryName] ?? `${mcpPrefix()}${registryName.replace(/\./g, "_")}`;
}

/** MCP-presented name → the name the handlers dispatch on. Raw
 *  registry names pass through (transition tolerance for early
 *  consumers of the unprefixed surface). */
export function registryName(presented: string): string {
  const pid = P().publisher.id;
  if (presented === `${pid}_ask`) return "ask";
  for (const [reg, mc] of Object.entries(MCP_NAME_OVERRIDES)) if (mc === presented) return reg;
  if (presented.startsWith(`${pid}_`)) {
    const rest = presented.slice(pid.length + 1);
    const hit = TOOLS_REGISTRY.find((t) => t.audiences.includes("mcp") && t.name.replace(/\./g, "_") === rest);
    if (hit) return hit.name;
  }
  return presented;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[] };
}

// the registry's MCP-audience tools are GENERATED here (OCP: adding a
// tool registers it; this list is never hand-extended for them)
export const TOOLS: McpTool[] = [
  {
    name: mcpName("ask"),
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
    name: mcpName("retrieve"),
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
  ...TOOLS_REGISTRY
    .filter((t) => t.audiences.includes("mcp"))
    .map((t): McpTool => ({
      name: mcpName(t.name),
      description: t.description,
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(t.params.map((p) => [p.key, { type: "string", description: p.description }])),
        required: t.params.filter((p) => p.required).map((p) => p.key),
      },
    })),
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
      return callTool(registryName(name), params?.arguments ?? {}).then(
        (payload) => ({ ok: true, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }) as McpResult,
      );
    }
    default:
      return Promise.resolve({ ok: false, code: -32601, message: `method not found: ${method}` });
  }
}
