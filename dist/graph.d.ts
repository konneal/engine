import type { Env } from "./env";
export declare function graphExpand(env: Env, u: {
    term?: string | null;
    defined_terms?: string[];
    docidentifier?: string | null;
} | null): Promise<string[] | undefined>;
/** Edition registry note (documents table): when the query names a
 *  publication, tell the model which editions are ACTIVE so superseded
 *  passages are treated as such — derived status from successor edges,
 *  not the fallible relaton status field. */
export declare function editionNote(env: Env, u: {
    doc_number?: string | null;
} | null): Promise<string | undefined>;
