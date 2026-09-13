import type { Env } from "./env";
export declare function kvIncr(cache: KVNamespace, key: string, step?: number): Promise<number>;
export declare function clientIp(req: Request): string;
/** Daily ask quota. `weight` is the effort multiplier: a thorough
 *  (elevated-effort) answer consumes more of the day's budget —
 *  different reasoning efforts naturally cost different quota. */
export declare function checkQuota(env: Env, bucket: string, id: string, limit: number, weight?: number): Promise<{
    ok: boolean;
    used: number;
    limit: number;
}>;
export declare function telemetry(env: Env, ctx: ExecutionContext, tier: string, route: string, model: string | null, ok: boolean, answerChars: number, queryHash: string, lang?: string): void;
