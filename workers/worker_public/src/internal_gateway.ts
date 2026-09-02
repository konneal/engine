// Internal-tier gateway: fetches FEDERATED passages (OIML + ISO/IEC) from
// rag-internal via the service binding. rag-public holds NO Vectorize
// binding to the internal index — this is the only path, member-gated.
// rag-internal is retrieval-only; the serving pipeline (rerank, grading,
// generation) stays here — one pipeline, both audiences.

import type { Hit } from "./pipeline";

interface ServiceFetcher {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

/** Any signed-in member gets both datasets (public + ISO). The tier
 *  distinction is: anonymous = public only, member = federated. */
export function hasInternalAccess(): boolean {
  return true;
}

/** Ask rag-internal for RRF-fused passages for the query. Returns [] on
 *  any failure — the public-only results then serve the member.
 *  `auth` forwards the caller's session in WHATEVER form it arrived
 *  (cookie same-origin, Bearer via the bubble bridge) — the internal
 *  worker's readSession accepts both. */
export async function retrieveInternal(
  service: ServiceFetcher,
  auth: { cookie: string; authorization: string },
  query: string,
): Promise<Hit[]> {
  try {
    const res = await service.fetch("https://internal/retrieve", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: auth.cookie, authorization: auth.authorization },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) return [];
    const data: any = await res.json();
    if (!Array.isArray(data?.hits)) return [];
    return data.hits.map((h: any) => ({
      id: h.id,
      score: h.score,
      metadata: h.metadata ?? {},
      text: h.text ?? "",
    }));
  } catch {
    return [];
  }
}
