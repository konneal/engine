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

/** The strict protocol: a line `TOOL <name> {…json…}`. Line-anchored,
 *  case-sensitive (prose never trips it); the args are the WHOLE rest
 *  of the line parsed as JSON — nested objects (db.find predicates)
 *  are legal, and a malformed or unterminated object is not a call. */
export function parseToolCall(text: string): ToolCall | null {
  const m = /^TOOL\s+([a-z_.]+)[ \t]*(\{.*)?$/m.exec(String(text ?? ""));
  if (!m) return null;
  const rest = (m[2] ?? "").trim();
  if (!rest) return { name: m[1].toLowerCase(), args: {} };
  if (!rest.startsWith("{")) return null;
  try {
    return { name: m[1].toLowerCase(), args: JSON.parse(rest) };
  } catch {
    return null;
  }
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

import { unitsGet, graphCites, docsSection, glossaryLookup, documentsFamily, licensedSection, verdictEvaluate, conditionsCheck, bibEntry, unitsLookup, unitsConvert } from "./tools-content.ts";
import { runFind, runSchema } from "./dbtools.ts";

// the data-plane grammar (dbtools.ts): the model composes typed
// predicates over the PUBLISHED schema — no operation menus, no raw SQL
const dbSchema: ToolSpec = {
  name: "db.schema",
  description:
    "The published data map: every queryable table (the certificate register, the document registry, the citation graph, the model plane, typed units, the corpus chunks) with its columns, types, and meanings. Call this first whenever a question turns on structured data; then compose db.find.",
  params: [{ key: "table", required: false, description: "one table's detail; omit for the whole catalog" }],
  audiences: ["agent", "mcp"],
  handler: async (_env, args) => {
    const t = args?.table ? String(args.table) : undefined;
    return runSchema(t);
  },
};

const dbFind: ToolSpec = {
  name: "db.find",
  description:
    "Query a published table with typed predicates you compose: where: [{col, op, value}] with ops eq|ne|lt|le|gt|ge|in|like|between, optional select, order_by {col, dir}, limit (≤25), group_by + agg {fn: count|sum|avg|min|max, col}. Values bind safely; identifiers validate against the schema (errors name the valid columns). Returns the matching rows or aggregate with the query echoed.",
  params: [
    { key: "table", required: true, description: "a published table (db.schema lists them)" },
    { key: "where", required: false, description: "[{col, op, value}] predicates, ANDed" },
    { key: "select", required: false, description: "columns to return; default per table" },
    { key: "order_by", required: false, description: "{col, dir: asc|desc}" },
    { key: "limit", required: false, description: "row cap, ≤25" },
    { key: "agg", required: false, description: "{fn, col?} aggregate instead of rows; with group_by: [cols]" },
  ],
  audiences: ["agent", "mcp"],
  handler: async (env, args) => {
    const findArgs = {
      table: String(args?.table ?? ""),
      where: Array.isArray(args?.where) ? args.where : [],
      select: Array.isArray(args?.select) ? args.select : undefined,
      order_by: args?.order_by && typeof args.order_by === "object" ? (args.order_by as { col: string; dir?: "asc" | "desc" }) : undefined,
      limit: args?.limit != null ? Number(args.limit) : undefined,
      group_by: Array.isArray(args?.group_by) ? args.group_by : undefined,
      agg: args?.agg && typeof args.agg === "object" ? (args.agg as { fn: "count" | "sum" | "avg" | "min" | "max"; col?: string }) : undefined,
    };
    if (!findArgs.table) return null;
    return runFind(env, findArgs);
  },
};

export const TOOLS_REGISTRY: ToolSpec[] = [dbSchema, dbFind, certificatesSearch, unitsGet, graphCites, docsSection, glossaryLookup, documentsFamily, licensedSection, verdictEvaluate, conditionsCheck, bibEntry, unitsLookup, unitsConvert];


/** The agent loop's protocol declaration, GENERATED from the registry —
 *  the model's tool vocabulary is always the registry's, never a
 *  hand-maintained literal. */
export const TOOL_DECLARATION = [
  "You may query data before answering, by writing ONE line per call:",
  ...TOOLS_REGISTRY.filter((t) => t.audiences.includes("agent")).map((t) => {
    const shape = `{${t.params.map((p) => `"${p.key}": <${p.description}>`).join(", ")}}`;
    return `TOOL ${t.name} ${shape}`;
  }),
  "The worker runs each call and returns the result attributed; you may issue up to three calls across the turns, one per turn, each on its own single line (compact JSON, no line breaks). Structured questions — counts, latest, filters, per-holder or per-year breakdowns over the register, document editions, model-plane requirements — start from TOOL db.schema (it lists the queryable tables and their columns), then compose TOOL db.find predicates. Each result arrives attributed: phrase it as what the tool returned, with your query visible in the answer. When you have enough, answer WITHOUT a TOOL line; if no tool helps, answer directly.",
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
