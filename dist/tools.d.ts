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
export declare function parseToolCall(text: string): ToolCall | null;
export interface ToolSpec {
    /** canonical on every surface */
    name: string;
    description: string;
    params: {
        key: string;
        required: boolean;
        description: string;
    }[];
    audiences: ("agent" | "mcp")[];
    handler: (env: any, args: Record<string, unknown>) => Promise<ToolResult | null>;
}
export declare const TOOLS_REGISTRY: ToolSpec[];
/** The agent loop's protocol declaration, GENERATED from the registry —
 *  the model's tool vocabulary is always the registry's, never a
 *  hand-maintained literal. */
export declare const TOOL_DECLARATION: string;
/** Dispatch by LOOKUP — a tool name is never hard-coded at a call site.
 *  The audience scopes the menu: the agent bridge sees agent tools, the
 *  MCP adapter sees mcp tools; a tool registered for both dispatches
 *  identically either way. */
export declare function runTool(env: any, call: ToolCall, audience?: "agent" | "mcp"): Promise<ToolResult | null>;
/** The attributed injection: the answer model sees what the tool
 *  returned, for the string it asked — never a standing claim. */
export declare function toolNote(r: ToolResult): string;
