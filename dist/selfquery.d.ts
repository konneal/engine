export interface QueryFilters {
    doctype?: string;
    doc_number?: string;
    edition?: string;
    language?: string;
}
export declare function toVectorizeFilter(f: QueryFilters): Record<string, string> | undefined;
