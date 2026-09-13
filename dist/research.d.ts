import type { Env } from "./env";
/** Deep-research mode (G10 v1): bounded agentic loop for members —
 *  retrieve → sufficiency judge → re-retrieve targeting the gap → answer
 *  from the ACCUMULATED evidence. ≤ max_iterations rounds; every
 *  iteration's retrieval goes through the same gated pipeline as a
 *  normal ask. Workflows (durable, resumable) is the documented upgrade
 *  path when runs outgrow a single request. */
export declare function handleResearch(env: Env, ctx: ExecutionContext, req: Request, session: any): Promise<Response>;
