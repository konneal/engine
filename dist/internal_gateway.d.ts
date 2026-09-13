import type { Hit } from "./pipeline";
interface ServiceFetcher {
    fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}
/** Ask rag-internal for RRF-fused passages for the query. Returns [] on
 *  any failure — the public-only results then serve the member.
 *  `auth` forwards the caller's session in WHATEVER form it arrived
 *  (cookie same-origin, Bearer via the bubble bridge) — the internal
 *  worker's readSession accepts both. */
export declare function retrieveInternal(service: ServiceFetcher, auth: {
    cookie: string;
    authorization: string;
}, query: string): Promise<Hit[]>;
export {};
