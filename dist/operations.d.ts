export declare function isOperationIntent(query: string): boolean;
export declare function matchOperations(query: string, rows: {
    anchor: string;
    text: string;
}[]): {
    anchor: string;
    text: string;
}[];
export declare function catalogNote(anchors: string[]): string;
export declare function operationsCatalogNote(db: any, query: string): Promise<string | undefined>;
