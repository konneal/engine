import type { Kv } from "./ports/kv.ts";
/** KV key carrying the corpus-generation stamp (the house sys:
 *  convention, cf. sys:generation). Absent = "0". */
export declare const CORPUS_GEN_KEY = "sys:corpus_gen";
/** Read the corpus-generation stamp; a KV failure fails open to "0"
 *  (the cache keeps working, generation pinning degrades to deploy-only). */
export declare function corpusGen(cache: Pick<Kv, "get">): Promise<string>;
/** The fresh (regenerate) flag: the JSON boolean, plus the string/1
 *  forms a caller may serialize. Anything else is not a bypass request. */
export declare function freshRequested(body: any): boolean;
/** The exact cache's hash input: the query lowercased and whitespace-
 *  folded, plus the output-language pin (a pinned language gets its own
 *  entry). Hashed with sha256Hex (./config) at the call site. */
/** `salt`: per-request context that materially changes the answer — the
 *  dataset scope selection and the memory-file selection. Requests that
 *  differ ONLY in salt share the query text, so an unsalted key would
 *  serve a scoped (or memory-flavored) answer to a plain ask. Null/empty
 *  = the default scope (no salt segment — keys stay byte-identical to
 *  the pre-salt era). */
export declare function cacheKeyMaterial(query: string, lang?: string, salt?: string | null): string;
export declare function exactCacheKey(indexVersion: string, gen: string, ns: string, queryHash: string): string;
export declare function semanticCacheKey(indexVersion: string, gen: string, signature: string): string;
