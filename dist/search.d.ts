import { type ApiKey } from "./lib/http";
import type { Env } from "./env";
export declare function handleSearch(env: Env, ctx: ExecutionContext, req: Request, tier: "anon" | "key" | "member", key: ApiKey | null): Promise<Response>;
