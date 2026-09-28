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
export declare function parseToolCall(text: string): ToolCall | null;
export declare const TOOL_DECLARATION = "You may use one tool before answering, by writing a single line:\nTOOL register_search {\"query\": \"manufacturer and model to look up\"}\nThe worker runs it against the OIML-CS certificate register (a snapshot) and returns the matching rows, or the exact no-match statement for the string you asked. Use it when the question turns on certification standing and the holder is known \u2014 including from a photograph. Then answer, phrasing the tool's result as what it returned (the searched string stays visible in your answer). If you do not need the tool, answer directly without the line.";
export declare function runTool(db: any, call: ToolCall): Promise<ToolResult | null>;
/** The attributed injection: the answer model sees what the tool
 *  returned, for the string it asked — never a standing claim. */
export declare function toolNote(r: ToolResult): string;
