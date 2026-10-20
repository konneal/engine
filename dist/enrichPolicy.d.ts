/** The model's raw response → the situating context: trimmed, the
 *  wrapping quotes stripped, capped at 400 chars. Empty string = the
 *  model had nothing to say (the deterministic-empty class). */
export declare function normalizeContext(raw: unknown): string;
export type EnrichOutcome = {
    action: "serve";
    context: string;
    cached: boolean;
} | {
    action: "serve-raw";
} | {
    action: "fail";
    error: string;
};
/** The per-chunk decision, given the cache read and the generation.
 *  - a context (cached or generated) serves enriched;
 *  - an EMPTY generation in the production flow serves the chunk RAW
 *    (the deterministic-empty class, 2026-10-20: real corpus content —
 *    B 18's thin terms sections, two R 134-1 clauses — must not vanish
 *    from the index because its enrichment has nothing to say; a later
 *    forced re-enrich overwrites the vector in place);
 *  - an empty generation in mode:context / mode:ab FAILS: those
 *    builders want the signal, not a side-effecting write. */
export declare function enrichOutcome(opts: {
    cached: string | null;
    generated: string;
    contextOnly: boolean;
    abMode: boolean;
}): EnrichOutcome;
