import { type ApiKey } from "./lib/http";
import type { Env } from "./env.ts";
import type { Background } from "./ports/runtime.ts";
export declare function handleMcp(env: Env, ctx: Background, req: Request, tier: "anon" | "key" | "member", key: ApiKey | null): Promise<Response>;
