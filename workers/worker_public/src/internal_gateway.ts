// Internal-tier gateway: delegates ask requests to rag-internal via a
// service binding when the user has an internal role. rag-public holds
// NO Vectorize binding to the internal index — this is the only path,
// and it's role-gated.

import { INTERNAL_ROLES } from "./auth";
import type { SessionClaims } from "./session";

interface ServiceFetcher {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

export function hasInternalAccess(session: SessionClaims): boolean {
  return session.roles.some((r) => INTERNAL_ROLES.includes(r));
}

/**
 * Forward the ask request to rag-internal via the service binding.
 * The internal worker handles: session validation, role check,
 * federated retrieval (both indexes), reranking, and generation.
 * Returns the complete response, or null on failure (caller falls
 * through to public-only retrieval).
 */
export async function delegateToInternal(
  service: ServiceFetcher,
  originalReq: Request,
  query: string,
  body: any,
): Promise<Response | null> {
  try {
    const internalReq = new Request("https://internal/api/ask", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // forward the session cookie — same signing secret on both workers
        cookie: originalReq.headers.get("cookie") ?? "",
      },
      body: JSON.stringify({
        query,
        stream: body?.stream ?? true,
        lang: body?.lang,
      }),
    });
    const res = await service.fetch(internalReq);
    if (!res.ok) return null;
    // pass through the response (SSE stream or JSON)
    return new Response(res.body, {
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/json",
        "cache-control": "no-cache",
      },
    });
  } catch {
    return null;
  }
}
