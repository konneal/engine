// ── The answer cache: key shape, the fresh bypass, corpus-surgery
//    invalidation (oimlsmart/rag#72) ──
//
// Answers are cached in KV under two key families, both TTL-bounded by
// LIMITS.cacheTtlSec:
//   a:<INDEX_VERSION>:g<gen>:<tier-ns>:<sha256(normalized query + "|" + lang)>
//     — the exact cache, one entry per (namespace, normalized query)
//   sc:<INDEX_VERSION>:g<gen>:<embedding signature>
//     — the semantic cache (near-duplicate queries, cosine-confirmed)
//
// Two invalidations, two key segments. INDEX_VERSION bumps on deploy
// (scripts/deploy.sh). The corpus generation `gen` (KV sys:corpus_gen)
// bumps after corpus SURGERY (scripts/invalidate_answer_cache.py):
// deleting chunks from D1/Vectorize touches no other key component, so
// without the generation segment a cached answer quoting deleted text
// kept serving until TTL — the 2026-09-04 incident (32 Spanish chunks
// of dirty:r79-2015-spa deleted; the exact-wording canary still drew the
// old answer). Old-generation entries simply miss and TTL out; nothing
// is enumerated or deleted. KV reads are edge-cached (~60s), so a bump
// takes up to a minute to reach every PoP — the ops script says so.
//
// fresh (regenerate): parsed ONCE here and honored at every answer-cache
// read. The strict `body?.fresh === true` checks this replaces were
// patched in per call site (the semantic-cache bypass regressed twice:
// 56e8bf7, 08a405d) and silently ignored the "true"/1 forms a JSON
// caller may serialize — a fresh ask that did not bypass.
//
// Self-contained (no imports) so the unit tests run on plain node type
// stripping, like anchors/refusal/verdict.

import type { Kv } from "./ports/kv.ts";
/** KV key carrying the corpus-generation stamp (the house sys:
 *  convention, cf. sys:generation). Absent = "0". */
export const CORPUS_GEN_KEY = "sys:corpus_gen";

/** Read the corpus-generation stamp; a KV failure fails open to "0"
 *  (the cache keeps working, generation pinning degrades to deploy-only). */
export async function corpusGen(cache: Pick<Kv, "get">): Promise<string> {
  try {
    return (await cache.get(CORPUS_GEN_KEY)) ?? "0";
  } catch {
    return "0";
  }
}

/** The fresh (regenerate) flag: the JSON boolean, plus the string/1
 *  forms a caller may serialize. Anything else is not a bypass request. */
export function freshRequested(body: any): boolean {
  const f = body?.fresh;
  return f === true || f === "true" || f === 1 || f === "1";
}

/** The exact cache's hash input: the query lowercased and whitespace-
 *  folded, plus the output-language pin (a pinned language gets its own
 *  entry). Hashed with sha256Hex (./config) at the call site. */
/** `salt`: per-request context that materially changes the answer — the
 *  dataset scope selection and the memory-file selection. Requests that
 *  differ ONLY in salt share the query text, so an unsalted key would
 *  serve a scoped (or memory-flavored) answer to a plain ask. Null/empty
 *  = the default scope (no salt segment — keys stay byte-identical to
 *  the pre-salt era). */
export function cacheKeyMaterial(query: string, lang?: string, salt?: string | null): string {
  return `${query.toLowerCase().replace(/\s+/g, " ").trim()}|${lang ?? ""}${salt ? "|" + salt : ""}`;
}

export function exactCacheKey(indexVersion: string, gen: string, ns: string, queryHash: string): string {
  return `a:${indexVersion}:g${gen}:${ns}:${queryHash}`;
}

export function semanticCacheKey(indexVersion: string, gen: string, signature: string): string {
  return `sc:${indexVersion}:g${gen}:${signature}`;
}
