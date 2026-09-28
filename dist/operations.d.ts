export declare function isOperationIntent(query: string): boolean;
/** camelCase/snake anchors meet the question's words: "updates an
 *  entity record" must reach putEntityRecord even when its description
 *  words the action differently ("replaces the stored…"). */
export declare function anchorWords(anchor: string): string[];
export declare function matchOperations(query: string, rows: {
    anchor: string;
    text: string;
}[]): {
    anchor: string;
    text: string;
}[];
export declare function catalogNote(anchors: string[]): string;
export declare function operationsCatalogNote(db: any, query: string): Promise<string | undefined>;
