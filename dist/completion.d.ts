import { type ResolvedBlock } from "./refs.ts";
import type { Hit } from "./pipeline.ts";
export declare function completeTables(db: D1Database, answer: string, used: Hit[]): Promise<ResolvedBlock[]>;
export declare function completeFigures(db: D1Database, answer: string, alreadyAttached: ResolvedBlock[]): Promise<ResolvedBlock[]>;
