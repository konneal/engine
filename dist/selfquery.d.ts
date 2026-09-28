export interface QueryFilters {
    doctype?: string;
    doc_number?: string;
    edition?: string;
    language?: string;
}
export declare function toVectorizeFilter(f: QueryFilters): Record<string, string> | undefined;
/** The one entitlement predicate: no key = public = always allowed; a key
 *  outside the caller's set = never allowed. `null`/undefined keys (the
 *  deployment declares no licensed content) disable the scope entirely. */
export declare function standardKeyAllowed(meta: {
    standard_key?: string;
}, keys: ReadonlySet<string> | null | undefined): boolean;
