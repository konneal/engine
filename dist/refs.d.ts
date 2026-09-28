import type { StoreQuery } from "./ports/store.ts";
export interface ResolvedBlock {
    unit_id: string;
    type: string;
    docidentifier: string;
    edition?: string;
    payload: Record<string, unknown>;
}
/** unit ids the passages actually contain (chunk metadata carries
 *  unit_id on typed MKO chunks). */
export declare function availableUnitIds(hits: ReadonlyArray<{
    metadata: {
        unit_id?: string | undefined;
    };
}>): Set<string>;
export declare function parseRefs(text: string): string[];
/** Drop refs that don't resolve to a used passage unit — a dangling ref
 *  renders as nothing (the token removed), and the violation is logged. */
export declare function sanitizeRefs(text: string, available: ReadonlySet<string>): {
    text: string;
    dropped: string[];
};
/** Resolve validated refs to producer payloads from D1 (unit_payloads).
 *  Unknown-to-D1 ids are skipped — a ref without a payload renders as a
 *  plain token, never as fabricated data. */
export declare function resolveBlocks(db: StoreQuery, refs: string[]): Promise<ResolvedBlock[]>;
/** One pass: validate + resolve + strip invalid tokens. */
export declare function contractV2(db: StoreQuery, answer: string, usedHits: ReadonlyArray<{
    metadata: {
        unit_id?: string | undefined;
    };
}>): Promise<{
    text: string;
    blocks: ResolvedBlock[];
    dropped: string[];
}>;
/** Detect table-retyping: a markdown table in the answer while a typed
 *  table unit was available to reference. Enforcement signal for the
 *  corrective regen (same pattern as quote-anchor violations). */
export declare function tableRetyped(text: string, availableTable: boolean): boolean;
