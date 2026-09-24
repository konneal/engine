// The dependency-free core of the session renewal (node-loadable for
// unit tests — the law that produced verdict-parse.ts): the refresh
// grant's backchannel classification and the claims merge with its
// sub guard. The stateful orchestration lives in oidc-refresh.ts.
import type { OidcIdTokenClaims, OidcTokenResponse } from "./oidc.ts";
import type { SessionClaims } from "./session";

export interface OidcMetadata {
  token_endpoint: string;
  jwks_uri: string;
}

export type RefreshResult =
  | { kind: "ok"; token: OidcTokenResponse }
  | { kind: "refused" }
  | { kind: "unavailable" };

/** The refresh grant's backchannel: the same shape as the code
 *  exchange's POST (the OP's WAF wants the issuer's own origin), with
 *  the three outcomes the renewal policy needs — a 400 is the OP
 *  REFUSING (revocation, expiry: dead), a network throw is
 *  unavailability (keep the session, retry next load). */
export async function refreshGrant(
  meta: OidcMetadata,
  cfg: { clientId: string; clientSecret?: string },
  refreshToken: string,
): Promise<RefreshResult> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: cfg.clientId,
  });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  headers.origin = new URL(meta.token_endpoint).origin;
  if (cfg.clientSecret) {
    headers.authorization = `Basic ${btoa(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`)}`;
  }
  let json: unknown;
  try {
    const res = await fetch(meta.token_endpoint, { method: "POST", headers, body });
    json = await res.json().catch(() => ({}));
    if (!res.ok) return { kind: "refused" };
  } catch {
    return { kind: "unavailable" };
  }
  const token = json as Partial<OidcTokenResponse>;
  if (typeof token?.id_token !== "string") return { kind: "unavailable" };
  return { kind: "ok", token: token as OidcTokenResponse };
}

/** The fresh session claims from the refresh grant's ID token. The sub
 *  MUST match (a different account is a provisioning error, never an
 *  update); every profile field falls back to the standing session's so
 *  a claim the OP omits never erases what the user already had. */
export function renewedSessionClaims(
  session: SessionClaims,
  claims: OidcIdTokenClaims,
): Omit<SessionClaims, "iat" | "exp"> | null {
  if (claims.sub !== session.sub) return null;
  return {
    sub: session.sub,
    name: typeof claims.name === "string" && claims.name ? claims.name : session.name,
    email: typeof claims.email === "string" && claims.email ? claims.email : session.email,
    picture: typeof claims.picture === "string" && claims.picture ? claims.picture : session.picture,
    roles: Array.isArray(claims.roles) ? claims.roles.map(String) : session.roles,
  };
}
