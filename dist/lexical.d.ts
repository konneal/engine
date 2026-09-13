import type { Hit } from "./pipeline";
/** Build a safe FTS5 MATCH query from user text: alphanumeric tokens,
 *  joined with OR so jargon hits don't require full-phrase match. */
export declare function ftsMatchQuery(query: string): string | null;
export declare function lexicalPrefilter(env: {
    DB: D1Database;
}, query: string, k?: number): Promise<Hit[]>;
