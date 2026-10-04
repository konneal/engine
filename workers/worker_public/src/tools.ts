// The agent interface's tool plane (the owner's 2026-09-28 direction): a
// bounded tool loop on the serving path. The model may invoke named
// tools through a strict line protocol; the worker executes each
// deterministically and the result rides back ATTRIBUTED — every tool
// output is phrased as what the tool returned, and the searched string
// is always visible in the answer. One round per ask, armed only where
// a tool can help (the certificate intent, v1).

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  name: string;
  query: string;
  output: string;
}

/** The strict protocol: a line `TOOL certificates.search {"query": "…"}`.
 *  Plain regex parse — no JSON mode needed, tolerant of surrounding
 *  prose (the model may talk around the call). */
export function parseToolCall(text: string): ToolCall | null {
  const m = /^TOOL\s+([a-z_.]+)\s*(\{[^\n}]*\})?/m.exec(String(text ?? "")); // line-anchored, case-sensitive: prose never trips it
  if (!m) return null;
  let args: Record<string, unknown> = {};
  if (m[2]) {
    try { args = JSON.parse(m[2]); } catch { return null; }
  } else if (/^TOOL\s+[a-z_.]+\s*\{/m.test(String(text ?? ""))) {
    return null; // a malformed call (opened, never closed) is not a call
  }
  return { name: m[1].toLowerCase(), args };
}

// ── the tool registry (OCP, the owner's 2026-10-04 direction) ────────
// ONE declared table is the single source of the tool surface: the agent
// loop's declaration is GENERATED from it, runTool dispatches by lookup,
// and the MCP server's tools/list is generated from the same entries.
// Adding a tool = adding one registration; no call site is edited.
export interface ToolSpec {
  /** canonical on every surface */
  name: string;
  description: string;
  params: { key: string; required: boolean; description: string }[];
  audiences: ("agent" | "mcp")[];
  handler: (env: any, args: Record<string, unknown>) => Promise<ToolResult | null>;
}

const certificatesSearch: ToolSpec = {
  name: "certificates.search",
  description:
    "Search the certificate register (a snapshot) by holder name, model designation, or a printed certificate number. Returns the matching rows — number, holder, model, issue year, status, and document links where on file — or the exact no-match statement for the string asked.",
  params: [{ key: "query", required: true, description: "the holder, model, or printed certificate number to look up" }],
  audiences: ["agent", "mcp"],
  handler: async (env, args) => {
    const query = String(args?.query ?? "").trim().slice(0, 160);
    if (!query) return null;
    const { searchRegister, registerNote, certificateLinks } = await import("./certificates");
    const reg = await searchRegister(env.DB, query, true); // the tool decided — no shaping gate
    const output = reg?.rows?.length
      ? [registerNote(reg.rows), certificateLinks(reg.rows)].filter(Boolean).join("\n")
      : `No certificate was found for "${query}" in the certificates database (the register snapshot). State this as the search's result, with the searched string visible.`;
    return { name: "certificates.search", query, output };
  },
};

import { unitsGet, graphCites, docsSection, glossaryLookup, documentsFamily, licensedSection } from "./tools-content.ts";

export const TOOLS_REGISTRY: ToolSpec[] = [certificatesSearch, unitsGet, graphCites, docsSection, glossaryLookup, documentsFamily, licensedSection];

/** The agent loop's protocol declaration, GENERATED from the registry —
 *  the model's tool vocabulary is always the registry's, never a
 *  hand-maintained literal. */
export const TOOL_DECLARATION = [
  "You may use one tool before answering, by writing a single line:",
  ...TOOLS_REGISTRY.filter((t) => t.audiences.includes("agent")).map((t) => {
    const shape = `{${t.params.map((p) => `"${p.key}": "<${p.description}>"`).join(", ")}}`;
    return `TOOL ${t.name} ${shape}`;
  }),
  "The worker runs it and returns the result attributed — phrase the tool's result as what it returned, with the searched string visible in your answer. Use a tool when the question turns on what it answers (including from a photograph). If you do not need it, answer directly without the line.",
].join("\n");

/** Dispatch by LOOKUP — a tool name is never hard-coded at a call site.
 *  The audience scopes the menu: the agent bridge sees agent tools, the
 *  MCP adapter sees mcp tools; a tool registered for both dispatches
 *  identically either way. */
export async function runTool(env: any, call: ToolCall, audience: "agent" | "mcp" = "agent"): Promise<ToolResult | null> {
  const spec = TOOLS_REGISTRY.find((t) => t.name === call.name && t.audiences.includes(audience));
  if (!spec) return null;
  return spec.handler(env, call.args ?? {});
}

/** The attributed injection: the answer model sees what the tool
 *  returned, for the string it asked — never a standing claim. */
export function toolNote(r: ToolResult): string {
  return `The ${r.name} tool returned, for the query "${r.query}":\n${r.output}`;
}
