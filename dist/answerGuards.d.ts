export declare function toolNarration(t: string): boolean;
export declare const TOOL_NARRATION_NOTICE = "Correction notice: your draft narrated an internal tool call ('the \u2026 tool returned \u2026') instead of answering. Rewrite: answer the question directly from the retrieved passages, cite the clauses, and never mention tools, queries, wire formats, or JSON.";
export declare function intentPreamble(t: string): boolean;
export declare const INTENT_PREAMBLE_NOTICE = "Correction notice: your draft announced a plan ('I'll look up \u2026') instead of answering. Do not narrate intent \u2014 answer the question NOW from the retrieved passages: give the values, clause references and citations the question asks for.";
