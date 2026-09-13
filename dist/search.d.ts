import type { Background } from "./ports/runtime.ts";
import { type ApiKey } from "./lib/http";
import type { Env } from "./env";
export declare function handleSearch(env: Env, ctx: Background, req: Request, tier: "anon" | "key" | "member", key: ApiKey | null): Promise<Response>;
