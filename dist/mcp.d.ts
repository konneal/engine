import { type ApiKey } from "./lib/http";
import type { Env } from "./env.ts";
export declare function handleMcp(env: Env, ctx: ExecutionContext, req: Request, tier: "anon" | "key" | "member", key: ApiKey | null): Promise<Response>;
