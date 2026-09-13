type AnyAi = {
    run: (model: string, body: unknown) => Promise<unknown>;
};
export declare function embed(ai: AnyAi, model: string, text: string): Promise<number[]>;
export declare function rerank(ai: AnyAi, model: string, query: string, texts: string[]): Promise<number[] | null>;
export declare function generateOnce(env: any, model: string, messages: any[], effort?: string): Promise<string | null>;
export {};
