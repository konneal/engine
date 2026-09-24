// The session's lifeline (TODO.identity-rp/01): a session's claims are
// frozen at mint — a deactivated account, a revoked role, a new avatar
// would all surface weeks late. So renewal is not a re-stamp of the old
// claims: when a session ages past the threshold, the RP presents the
// OP's refresh token, and the OP's refresh grant re-judges the LIVE
// standing (deactivation kills the grant family → the next renewal ends
// the session, and the response carries today's name/picture/roles).
// The rotated refresh token must be stored after every use — the OP's
// rotation is one-time, and a reuse verdict revokes the whole family.

import { discoverIssuer, validateIdToken, type OidcIdTokenClaims } from "./oidc.ts";
import { renewedSessionClaims, refreshGrant, type OidcMetadata } from "./refresh-core.ts";
import { sha256Hex } from "./config";
import type { SessionClaims } from "./session";

const REFRESH_TTL_SEC = 30 * 24 * 60 * 60; // the OP's grant TTL default

const REFRESH_KEY = (sessionHash: string) => `ort:${sessionHash}`;

export interface RenewedSession {
  claims: Omit<SessionClaims, "iat" | "exp">;
  refreshToken: string;
}

export type RenewOutcome =
  | { kind: "ok"; renewed: RenewedSession }
  | { kind: "revoked" }
  | { kind: "unavailable" };

export async function retainRefreshToken(env: any, sessionRaw: string, refreshToken: string): Promise<void> {
  try {
    await env.CACHE.put(REFRESH_KEY(await sha256Hex(sessionRaw)), JSON.stringify({ token: refreshToken }), {
      expirationTtl: REFRESH_TTL_SEC,
    });
  } catch {
    // a KV hiccup degrades to the legacy staleness, never blocks sign-in
  }
}

async function readRefreshToken(env: any, sessionRaw: string): Promise<string | null> {
  try {
    const hit = await env.CACHE.get(REFRESH_KEY(await sha256Hex(sessionRaw)), "json");
    return typeof hit?.token === "string" ? hit.token : null;
  } catch {
    return null;
  }
}

async function dropRefreshToken(env: any, sessionRaw: string): Promise<void> {
  try {
    await env.CACHE.delete(REFRESH_KEY(await sha256Hex(sessionRaw)));
  } catch {
    // best effort
  }
}

export async function renewSessionClaims(
  env: any,
  cfg: { issuer: string; clientId: string; clientSecret?: string; sessionSecret: string },
  session: SessionClaims,
  sessionRaw: string,
): Promise<RenewOutcome> {
  const stored = await readRefreshToken(env, sessionRaw);
  if (!stored) return { kind: "unavailable" };
  let meta;
  try {
    meta = (await discoverIssuer(cfg.issuer)) as unknown as OidcMetadata;
  } catch {
    return { kind: "unavailable" };
  }
  const granted = await refreshGrant(meta, cfg, stored);
  // the OP's refusal IS the revocation signal (deactivated, signed out
  // everywhere, expired) — the renewal ends; unavailability keeps the
  // session for the next load
  if (granted.kind === "refused") {
    await dropRefreshToken(env, sessionRaw);
    return { kind: "revoked" };
  }
  if (granted.kind === "unavailable") return granted;
  const token = granted.token;
  if (typeof token.refresh_token !== "string" || !token.refresh_token) {
    // a rotation without a successor: the OP is telling us the grant is
    // finished (narrowed away) — treat as revoked
    await dropRefreshToken(env, sessionRaw);
    return { kind: "revoked" };
  }
  let claims: OidcIdTokenClaims;
  try {
    claims = await validateIdToken(token.id_token, {
      issuer: cfg.issuer,
      clientId: cfg.clientId,
      nonce: undefined as unknown as string,
      jwksUri: meta.jwks_uri,
    });
  } catch {
    return { kind: "unavailable" };
  }
  const fresh = renewedSessionClaims(session, claims);
  if (!fresh) {
    await dropRefreshToken(env, sessionRaw);
    return { kind: "revoked" };
  }
  await retainRefreshToken(env, sessionRaw, token.refresh_token);
  return { kind: "ok", renewed: { claims: fresh, refreshToken: token.refresh_token } };
}
