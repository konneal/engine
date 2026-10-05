import type { Hit } from "./pipeline";
/** Build a safe FTS5 MATCH query from user text: alphanumeric tokens,
 *  joined with OR so jargon hits don't require full-phrase match. */
export declare function ftsMatchQuery(query: string): string | null;
/** Lexical ranking WITHIN a document set (the graph lanes' identity
 *  resolution): BM25 over the corpus's own FTS, restricted to the
 *  documents' doc_number values. This is the working substitute for
 *  Vectorize metadata filtering, which is dead on this index (measured
 *  2026-10-05: filters return empty for values proven present). */
export declare function lexicalWithin(env: {
    DB: D1Database;
}, query: string, docNumbers: string[], k?: number): Promise<{
    id: string;
    score: number;
    metadata: Record<string, unknown>;
}[]>;
export declare function lexicalPrefilter(env: {
    DB: D1Database;
}, query: string, k?: number): Promise<Hit[]>;
