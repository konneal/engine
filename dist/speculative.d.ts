export declare const SPECULATIVE_SUBSETS = 3;
/** Minimal structural shape the partition reads. */
export interface Partitionable {
    metadata: {
        docidentifier?: string;
        doc_id?: string;
    };
}
export declare function partitionSubsets<T extends Partitionable>(hits: T[], k?: number): T[][] | null;
