import type { Env } from "./env";
export type { Env };
import { type ApiKey } from "./lib/http";
declare function handleAsk(env: Env, ctx: ExecutionContext, req: Request, tier: "anon" | "key" | "member", key: ApiKey | null): Promise<Response>;
export { handleAsk };
