import type { ModelRunner } from "./ports/model.ts";
import { type QueryUnderstanding } from "./understandContract.ts";
export type { QueryUnderstanding };
/** Understand the query with the cheap model. Null = use the regex fallback. */
export declare function understandQuery(ai: ModelRunner, model: string, query: string, history: Array<{
    role: string;
    content: string;
}>, entities?: Array<{
    entity: string;
    kind: string;
}>): Promise<QueryUnderstanding | null>;
