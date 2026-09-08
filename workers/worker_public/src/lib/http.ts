// HTTP wire helpers + request validation + API-key authentication —
// the vocabulary every route handler speaks (TODO.impl/23).
import { LIMITS, sha256Hex } from "../config";
import type { Env } from "../env";

export const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });

export const err = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed =
    origin === "https://oimlsmart.org" ||
    /^https:\/\/[a-z0-9-]+\.oimlsmart\.org$/.test(origin) ||
    // the local dev posture: the platform and the minisites develop on
    // localhost ports against the live service (the bubble bridge admits
    // the same class; anon quota is per-IP, member auth needs the token)
    /^http:\/\/localhost(:\d{1,5})?$/.test(origin) ||
    /^http:\/\/127\.0\.0\.1(:\d{1,5})?$/.test(origin);
  return allowed
    ? {
        "access-control-allow-origin": origin,
        // PATCH + DELETE: the conversations API speaks them (rename,
        // delete) — the embedded panel preflights cross-origin.
        "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "86400",
      }
    : {};
}

/** CORS-complete a handler's response: the browser surface grew
 *  piecemeal (the SSE ask paths carried the headers; the JSON + error
 *  paths and the conversations API did not), which an embedded
 *  cross-origin client reads as opaque network failures. One wrap at
 *  the router keeps every browser-facing answer readable. */
export function withCors(res: Response, cors: Record<string, string>): Response {
  if (!cors["access-control-allow-origin"]) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export interface ApiKey {
  id: string;
  name: string;
  day_limit: number;
}

export async function authenticate(env: Env, req: Request): Promise<ApiKey | null> {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const keyHash = await sha256Hex(m[1].trim());
  const row = await env.DB.prepare(
    "SELECT id, name, day_limit FROM api_keys WHERE key_hash = ?1 AND revoked = 0",
  )
    .bind(keyHash)
    .first<ApiKey>();
  return row ?? null;
}

export async function readJson(req: Request): Promise<any | null> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object") return null;
    return body;
  } catch {
    return null;
  }
}

export function validateQuery(body: any): { query: string; lang?: string } | null {
  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (!query || query.length > LIMITS.maxInputChars) return null;
  const lang = typeof body?.lang === "string" && /^[a-z]{2}$/.test(body.lang) ? body.lang : undefined;
  return { query, lang };
}
