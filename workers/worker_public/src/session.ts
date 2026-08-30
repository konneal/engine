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
  let raw: string | undefined = parseCookies(req)[SESSION_COOKIE];
  if (!raw) {
    const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
    raw = m?.[1]?.trim();
  }
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

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
