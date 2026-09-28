import type { ModelRunner } from "./ports/model.ts";
type AnyAi = ModelRunner;
export declare function embed(ai: ModelRunner, _model: string, text: string): Promise<number[]>;
export declare function rerank(ai: AnyAi, model: string, query: string, texts: string[]): Promise<number[] | null>;
export declare function generateOnce(env: any, model: string, messages: any[], effort?: string): Promise<string | null>;
export {};
