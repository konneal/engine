export declare const PROTOCOL_VERSION = "2025-06-18";
/** Registry tool name → the MCP-presented name. */
export declare function mcpName(registryName: string): string;
/** MCP-presented name → the name the handlers dispatch on. Raw
 *  registry names pass through (transition tolerance for early
 *  consumers of the unprefixed surface). */
export declare function registryName(presented: string): string;
export interface McpTool {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: Record<string, unknown>;
        required: string[];
    };
}
export declare const TOOLS: McpTool[];
export type McpResult = {
    ok: true;
    result: unknown;
} | {
    ok: true;
    accepted: true;
} | {
    ok: false;
    code: number;
    message: string;
};
/** Dispatch one JSON-RPC request; `callTool` adapts a tool call to the
 *  real handlers (the route adapter's job). */
export declare function dispatch(method: string | null, params: any, callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>): Promise<McpResult>;
