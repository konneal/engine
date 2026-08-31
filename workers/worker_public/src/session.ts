// RAG's own session layer: the OP's ID token is sign-in evidence, never a
// session (docs/identity-service.md §5.5). We mint an HMAC-signed cookie
// with the claims we act on; enforcement happens inside this worker.

export interface SessionClaims {
  sub: string;
  name?: string;
  email?: string;
  roles: string[];
  iat: number;
  exp: number;
}

export const SESSION_COOKIE = "rag_session";
const SESSION_TTL_SEC = 7 * 24 * 3600;

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function mintSessionToken(secret: string, claims: Omit<SessionClaims, "exp" | "iat">): Promise<{ token: string; expiresAt: number }> {
  const full: SessionClaims = { ...claims, iat: Date.now(), exp: Date.now() + SESSION_TTL_SEC * 1000 };
  const payload = btoa(JSON.stringify(full))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const sig = await hmac(secret, payload);
  return { token: `${payload}.${sig}`, expiresAt: full.exp };
}

export async function mintSessionCookie(secret: string, claims: Omit<SessionClaims, "exp" | "iat">): Promise<string> {
  const { token } = await mintSessionToken(secret, claims);
  return sessionCookieFromToken(token);
}

/** The Set-Cookie value for an already-minted session token (the sign-in
 *  mints ONCE and both the cookie and the bubble Bearer carry it —
 *  TODO.ai-platform/03's live-data window keys off the one token). */
export function sessionCookieFromToken(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL_SEC}; HttpOnly; Secure; SameSite=Lax`;
}

export function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export async function readSession(req: Request, secret: string | undefined): Promise<SessionClaims | null> {
  if (!secret) return null;
  // The cookie is the same-origin posture; the Bearer form is the bubble
  // bridge (bubble.ts) — the same signed payload, sent cross-origin by
  // the embedded panel. Cookie first so a stale stored token never
  // shadows a live cookie session on the ai property itself.
  const raw = rawSessionToken(req);
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  const expected = await hmac(secret, payload);
  if (sig !== expected) return null;
  try {
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/") + "===".slice(0, (4 - (payload.length % 4)) % 4);
    const claims = JSON.parse(atob(b64)) as SessionClaims;
    if (typeof claims.sub !== "string" || typeof claims.exp !== "number") return null;
    if (claims.exp + 60_000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

/** The raw session token as presented (the cookie wins the tie, exactly
 *  as readSession) — the live-data window's KV key derives from it
 *  (TODO.ai-platform/03; the key is the token's hash, never the token). */
export function rawSessionToken(req: Request): string | null {
  const raw =
    parseCookies(req)[SESSION_COOKIE] ??
    (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return raw || null;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
