// The enrichment route's decision policy, dependency-free so plain node
// can load it for unit tests (admin.ts imports .md prompts that only
// the bundler resolves — the serve-raw policy rode the live
// verification alone until this extraction). The handler keeps the
// I/O: cache, generation, embedding, upsert; this module owns the
// DECISION table — what a chunk's outcome is, given what came back.

/** The model's raw response → the situating context: trimmed, the
 *  wrapping quotes stripped, capped at 400 chars. Empty string = the
 *  model had nothing to say (the deterministic-empty class). */
export function normalizeContext(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().replace(/^["\']|["']$/g, "").slice(0, 400) : "";
}

export type EnrichOutcome =
  | { action: "serve"; context: string; cached: boolean }
  | { action: "serve-raw" }
  | { action: "fail"; error: string };

/** The per-chunk decision, given the cache read and the generation.
 *  - a context (cached or generated) serves enriched;
 *  - an EMPTY generation in the production flow serves the chunk RAW
 *    (the deterministic-empty class, 2026-10-20: real corpus content —
 *    B 18's thin terms sections, two R 134-1 clauses — must not vanish
 *    from the index because its enrichment has nothing to say; a later
 *    forced re-enrich overwrites the vector in place);
 *  - an empty generation in mode:context / mode:ab FAILS: those
 *    builders want the signal, not a side-effecting write. */
export function enrichOutcome(opts: {
  cached: string | null;
  generated: string;
  contextOnly: boolean;
  abMode: boolean;
}): EnrichOutcome {
  const fromCache = typeof opts.cached === "string" && opts.cached;
  if (fromCache) return { action: "serve", context: fromCache, cached: true };
  if (opts.generated) return { action: "serve", context: opts.generated, cached: false };
  if (opts.contextOnly || opts.abMode) return { action: "fail", error: "empty enrichment" };
  return { action: "serve-raw" };
}
