export interface AggregationVerdict {
    operation: "count" | "min" | "max" | "lookup";
    table: string;
    table_title?: string;
    column?: string;
    value: number | string | null;
    unit?: string;
    row?: Record<string, string>;
    note: string;
}
/** Evaluate the candidate table nodes against the question's
 *  aggregation intent. One verdict: the operation the question names,
 *  computed over the best-matching table's typed payload. */
export declare function evaluateAggregation(nodes: {
    node_id: string;
    content: unknown;
}[], query: string): AggregationVerdict | null;
