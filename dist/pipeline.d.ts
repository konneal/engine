export { refusalAnswer } from "./refusal";
/** The interpolation source for every prompt: the profile's declared
 *  vars plus the derived publisher tokens. Call sites never build
 *  their own var map. */
export declare function promptVars(extra?: Record<string, string>): Record<string, string>;
/** Fill {{TOKEN}} placeholders in a prompt data file. Unknown/empty tokens
 *  resolve to "" so optional lines vanish cleanly. */
export declare function fill(template: string, vars: Record<string, string>): string;
import { QueryFilters } from "./selfquery";
import type { RetrieveOptions, GlossaryEntry } from "./stages/types";
export type { ChunkMeta, Hit } from "../../shared/chunk";
import type { Hit } from "../../shared/chunk";
export interface Retrieved {
    hits: Hit[];
    filters: QueryFilters;
    /** vocabulary link (the L2 nomenclature bridge): top defined-term
     *  candidates for the question's subject — the answer model adjudicates
     *  among them (dense retrieval alone binds everyday words to the wrong
     *  term: measured "keeps drifting" → creep 0.69 vs durability 0.54) */
    glossary?: GlossaryEntry[];
    /** structured facts stages extracted from the graph (GraphRAG) —
     *  merged into the answer prompt's retrieval note */
    notes?: string[];
}
export declare function retrievalQuery(query: string, prev?: string): string;
export declare function retrieve(env: any, query: string, opts?: RetrieveOptions): Promise<Retrieved>;
export interface HistoryTurn {
    role: "user" | "assistant";
    content: string;
}
export interface BuiltMessages {
    messages: {
        role: string;
        content: string;
    }[];
    usedHits: Hit[];
}
/** System instruction for a conversational (non-knowledge) turn: the
 *  service facts the model speaks from, composed from the DATASETS
 *  catalog — the same SSOT /api/datasets serves. Routing is decided by
 *  query UNDERSTANDING (understanding.ts), never by string matching. */
export declare function identityNote(member: boolean): string;
/** Split history into the turns that fit the budget slice (kept, newest)
 *  and the older ones that must be compacted into a summary (overflow). */
export declare function splitHistory(history: HistoryTurn[], budgetTokens: number): {
    kept: HistoryTurn[];
    overflow: HistoryTurn[];
};
/** Final-tier LLM listwise rerank: jointly reorders the top passages for
 *  hard queries (cascade stage after the cross-encoder). Null = keep the
 *  incoming order (timeout/parse failure never blocks serving). */
export declare function listwiseRerank(env: any, model: string, query: string, hits: Hit[]): Promise<Hit[] | null>;
export declare function buildMessages(query: string, hits: Hit[], lang?: string, history?: HistoryTurn[], retrievalNote?: string, conversationSummary?: string, budgetTokens?: number): BuiltMessages;
export declare function citations(hits: Hit[]): {
    doc_id: string;
    docidentifier: string;
    edition: string;
    language: string;
    clause_anchor: string;
    clause_title: string;
    status: string;
    superseded_by: string | undefined;
    corpus: any;
    quality: import("./quality").SourceQuality;
    url: string | undefined;
    snippet: string;
    score: number;
}[];
