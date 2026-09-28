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

/** The strict protocol: a line `TOOL register_search {"query": "…"}`.
 *  Plain regex parse — no JSON mode needed, tolerant of surrounding
 *  prose (the model may talk around the call). */
export function parseToolCall(text: string): ToolCall | null {
  const m = /^TOOL\s+([a-z_]+)\s*(\{[^\n}]*\})?/m.exec(String(text ?? "")); // line-anchored, case-sensitive: prose never trips it
  if (!m) return null;
  let args: Record<string, unknown> = {};
  if (m[2]) {
    try { args = JSON.parse(m[2]); } catch { return null; }
  } else if (/^TOOL\s+[a-z_]+\s*\{/m.test(String(text ?? ""))) {
    return null; // a malformed call (opened, never closed) is not a call
  }
  return { name: m[1].toLowerCase(), args };
}

export const TOOL_DECLARATION = `You may use one tool before answering, by writing a single line:
TOOL register_search {"query": "manufacturer and model to look up"}
The worker runs it against the certificate register (a snapshot) and returns the matching rows, or the exact no-match statement for the string you asked. Use it when the question turns on certification standing and the holder is known — including from a photograph. Then answer, phrasing the tool's result as what it returned (the searched string stays visible in your answer). If you do not need the tool, answer directly without the line.`;

export async function runTool(db: any, call: ToolCall): Promise<ToolResult | null> {
  if (call.name !== "register_search") return null;
  const query = String(call.args?.query ?? "").trim().slice(0, 160);
  if (!query) return null;
  const { searchRegister, registerNote } = await import("./certificates");
  const reg = await searchRegister(db, query);
  const output = reg?.rows?.length
    ? registerNote(reg.rows)
    : `No certificate was found for "${query}" in the certificates database (the register snapshot). State this as the search's result, with the searched string visible.`;
  return { name: call.name, query, output };
}

/** The attributed injection: the answer model sees what the tool
 *  returned, for the string it asked — never a standing claim. */
export function toolNote(r: ToolResult): string {
  return `The ${r.name} tool returned, for the query "${r.query}":\n${r.output}`;
}
