import type { Env } from "./env";
export type { Env };
import { type ApiKey } from "./lib/http";
declare function handleAsk(env: Env, ctx: ExecutionContext, req: Request, tier: "anon" | "key" | "member", key: ApiKey | null): Promise<Response>;
/** RAGAS-style metric battery (G13): judge an (question, answer, passages)
 *  triple — faithfulness, answer relevancy, context precision. Driven by
 *  tests/eval-suite.mjs; prompts are data; refuses nothing, judges only. */
export { handleAsk };
