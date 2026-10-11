import type { Env } from "./env";
import type { Background } from "./ports/runtime.ts";
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
export declare function telemetry(env: Env, ctx: Background, tier: string, route: string, model: string | null, ok: boolean, answerChars: number, queryHash: string, lang?: string, cache?: "exact" | "semantic", meta?: {
    durationMs?: number;
    keyId?: string | null;
    retries?: number;
}): void;
export declare function estimateTokens(chars: number): number;
export declare function tokenLimit(env: Env, bucketId: string): number;
export declare function tokenBudget(env: Env, bucketId: string): Promise<{
    used: number;
    limit: number;
}>;
export declare function chargeTokens(env: Env, bucketId: string, tokens: number): Promise<void>;
export declare function usageTotal(usage: unknown): number | null;
export declare const CREDIT_TOKEN_UNIT = 1000;
export declare function creditLimit(env: Env, bucketId: string): number;
export declare function creditBudget(env: Env, bucketId: string): Promise<{
    credits_used: number;
    credits_limit: number;
}>;
/** The credit-price preview for an ask: effort, tool turns armed, and
 *  multimodality each add real consumption — the estimate shown BEFORE
 *  generation so users see what a mode costs. Honest, not exact. */
export declare function creditEstimate(opts: {
    effort: string;
    toolTurns: number;
    image: boolean;
}): number;
