import type { StoreQuery } from "./ports/store.ts";
import { type ResolvedBlock } from "./refs.ts";
import type { Hit } from "./pipeline.ts";
export declare function completeTables(db: StoreQuery, answer: string, used: Hit[]): Promise<ResolvedBlock[]>;
export declare function completeFigures(db: StoreQuery, answer: string, alreadyAttached: ResolvedBlock[]): Promise<ResolvedBlock[]>;
