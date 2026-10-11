export interface CatalogColumn {
    name: string;
    type: "text" | "number";
    description: string;
    /** ordering/comparison compiles CAST(col AS INTEGER) — textual columns
     *  carrying numeric content (certificates.year is TEXT in D1) */
    numeric_cast?: boolean;
    /** excluded from the default select (heavy bodies); still selectable by name */
    wide?: boolean;
}
export interface CatalogTable {
    name: string;
    description: string;
    columns: CatalogColumn[];
    default_select: string[];
}
export declare const DB_CATALOG: CatalogTable[];
export declare function publishedTable(name: string): CatalogTable | undefined;
export declare const FIND_OPS: readonly ["eq", "ne", "lt", "le", "gt", "ge", "in", "like", "between"];
export type FindOp = (typeof FIND_OPS)[number];
export interface FindPredicate {
    col: string;
    op: FindOp;
    value: unknown;
}
export interface FindArgs {
    table: string;
    where?: FindPredicate[];
    select?: string[];
    order_by?: {
        col: string;
        dir?: "asc" | "desc";
    };
    limit?: number;
    group_by?: string[];
    agg?: {
        fn: "count" | "sum" | "avg" | "min" | "max";
        col?: string;
    };
}
export type Compiled = {
    ok: true;
    sql: string;
    params: unknown[];
    echo: string;
} | {
    ok: false;
    error: string;
};
/** Compile validated identifiers + bound parameters. Returns a
 *  schema-linked error (naming the valid columns) on any mismatch —
 *  the model corrects from the error, the loop continues. */
export declare function compileFind(args: FindArgs): Compiled;
/** The db.find handler: compile, run on D1, format deterministically.
 *  Every output carries the predicate echo — the answer attributes the
 *  rows to the query that produced them. */
export declare function runFind(env: any, args: FindArgs): Promise<{
    name: string;
    query: string;
    output: string;
} | null>;
/** The db.schema handler: the published map, one table or the catalog. */
export declare function runSchema(table?: string): {
    name: string;
    query: string;
    output: string;
};
