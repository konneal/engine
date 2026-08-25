// Auth routes: OIDC authorization-code + PKCE against the estate OP
// (id.oimlsmart.org), per docs/identity-service.md. The OP declares WHO
// the user is; quota tiers (what they may do here) are ours.

import {
  buildAuthorizationUrl,
  buildEndSessionUrl,
  discoverIssuer,
  exchangeCode,
  generatePkce,
  randomToken,
  validateIdToken,
  OidcError,
} from "./oidc";
import { clearSessionCookie, mintSessionCookie, readSession, SessionClaims } from "./session";

const PLAIN_LANGUAGE: Record<string, string> = {
  not_configured: "Sign-in is not configured for this service yet.",
  discovery: "The sign-in service could not be reached. Please try again shortly.",
  issuer_mismatch: "The sign-in service answered from an unexpected address. Sign-in was refused.",
  exchange: "The sign-in service refused the sign-in. Please try again.",
  state: "That sign-in link has expired. Please start again.",
  token_malformed: "The sign-in service returned an unreadable token. Please try again.",
  token_alg: "The sign-in service returned a token in an unsupported format.",
  token_signature: "The sign-in token could not be verified. Sign-in was refused.",
  token_issuer: "The sign-in token was issued by an unexpected party. Sign-in was refused.",
  token_audience: "The sign-in token was not issued for this service. Sign-in was refused.",
  token_expired: "The sign-in window expired. Please sign in again.",
  token_nonce: "The sign-in response failed its replay check. Please sign in again.",
};

export function authErrorText(reason: string): string {
  return PLAIN_LANGUAGE[reason] ?? "Sign-in failed. Please try again.";
}

// Two tiers only: anonymous (public index) and member (both indexes).
// Estate roles (mc_member, etc.) are identity claims, NOT access gates
// here — any authenticated user is a member.
export const INTERNAL_ROLES: string[] = []; // deprecated: kept for API compat

export interface AuthConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  sessionSecret: string;
}

export function authConfig(env: any): AuthConfig | null {
  const issuer = env.OIDC_ISSUER ?? "https://id.oimlsmart.org";
  const clientId = env.OIDC_CLIENT_ID;
  const redirectUri = env.OIDC_REDIRECT_URI ?? "https://ai.oimlsmart.org/auth/callback";
  const sessionSecret = env.SESSION_SECRET;
  if (!clientId || !sessionSecret) return null;
  return { issuer, clientId, redirectUri, sessionSecret };
}

const redirectWithError = (reason: string) =>
  new Response(null, {
    status: 302,
    headers: { location: `/?auth_error=${reason}&auth_msg=${encodeURIComponent(authErrorText(reason))}` },
  });

export async function handleLogin(env: any, req: Request): Promise<Response> {
  const cfg = authConfig(env);
  if (!cfg) return redirectWithError("not_configured");
  try {
    const meta = await discoverIssuer(cfg.issuer);
    const state = randomToken();
    const nonce = randomToken();
    const pkce = await generatePkce();
    await env.CACHE.put(`oa:${state}`, JSON.stringify({ nonce, verifier: pkce.verifier }), {
      expirationTtl: 600,
    });
    const url = buildAuthorizationUrl(meta, {
      clientId: cfg.clientId,
      redirectUri: cfg.redirectUri,
      scopes: "openid profile email roles",
      state,
      nonce,
      codeChallenge: pkce.challenge,
    });
    return new Response(null, { status: 302, headers: { location: url } });
  } catch (e) {
    return redirectWithError(e instanceof OidcError ? e.reason : "discovery");
  }
}

export async function handleCallback(env: any, req: Request): Promise<Response> {
  const cfg = authConfig(env);
  if (!cfg) return redirectWithError("not_configured");
  const url = new URL(req.url);
  const opError = url.searchParams.get("error");
  if (opError) {
    // the OP redirected back with its own failure (user denied consent,
    // session expired at the OP, …) — fail closed, in plain language
    const msg =
      opError === "access_denied"
        ? "Sign-in was cancelled."
        : opError === "temporarily_unavailable"
          ? "The sign-in service is busy. Please try again in a moment."
          : "The sign-in service reported a problem. Please try again.";
    return new Response(null, {
      status: 302,
      headers: { location: `/?auth_error=${encodeURIComponent(opError)}&auth_msg=${encodeURIComponent(msg)}` },
    });
  }
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !state) return redirectWithError("state");

  const stored = await env.CACHE.get(`oa:${state}`, "json");
  if (!stored) return redirectWithError("state");
  // one-time: the state is consumed whether or not the exchange succeeds
  await env.CACHE.delete(`oa:${state}`);

  try {
    const meta = await discoverIssuer(cfg.issuer);
    const token = await exchangeCode(meta, {
      clientId: cfg.clientId,
      clientSecret: env.OIDC_CLIENT_SECRET,
      code,
      redirectUri: cfg.redirectUri,
      codeVerifier: stored.verifier,
    });
    const claims = await validateIdToken(token.id_token, {
      issuer: cfg.issuer,
      clientId: cfg.clientId,
      nonce: stored.nonce,
      jwksUri: meta.jwks_uri,
    });
    const roles = Array.isArray(claims.roles) ? claims.roles.map(String) : [];
    const cookie = await mintSessionCookie(cfg.sessionSecret, {
      sub: claims.sub,
      name: typeof claims.name === "string" ? claims.name : undefined,
      email: typeof claims.email === "string" ? claims.email : undefined,
      roles,
    });
    return new Response(null, { status: 302, headers: { location: "/", "set-cookie": cookie } });
  } catch (e) {
    if (e instanceof OidcError) console.error("auth callback:", e.reason, "—", e.message.slice(0, 200));
    return redirectWithError(e instanceof OidcError ? e.reason : "exchange");
  }
}

export async function sessionFrom(req: Request, env: any): Promise<SessionClaims | null> {
  return readSession(req, authConfig(env)?.sessionSecret);
}

export async function handleMe(env: any, req: Request): Promise<Response> {
  const cfg = authConfig(env);
  const session = cfg ? await readSession(req, cfg.sessionSecret) : null;
  const headers: Record<string, string> = { "content-type": "application/json" };
  // sliding renewal: a session older than a day re-mints on sight, so
  // active users never hit the 7-day wall mid-conversation
  if (session && cfg && Date.now() - session.iat > 24 * 3600 * 1000) {
    headers["set-cookie"] = await mintSessionCookie(cfg.sessionSecret, {
      sub: session.sub,
      name: session.name,
      email: session.email,
      roles: session.roles,
    });
  }
  return new Response(
    JSON.stringify({
      authenticated: !!session,
      name: session?.name ?? null,
      email: session?.email ?? null,
      roles: session?.roles ?? [],
      tier: session ? "member" : "anon",
      sign_in_available: !!cfg,
    }),
    { headers },
  );
}

export async function handleLogout(env: any, req: Request): Promise<Response> {
  const cfg = authConfig(env);
  const headers: Record<string, string> = { "set-cookie": clearSessionCookie() };
  if (cfg) {
    try {
      const meta = await discoverIssuer(cfg.issuer);
      const end = buildEndSessionUrl(meta, {
        clientId: cfg.clientId,
        postLogoutRedirectUri: env.OIDC_REDIRECT_URI ?? "https://ai.oimlsmart.org/",
      });
      if (end) {
        headers.location = end;
        return new Response(null, { status: 302, headers });
      }
    } catch {
      // OP-side logout is best-effort; the local session is already cleared
    }
  }
  headers.location = "/";
  return new Response(null, { status: 302, headers });
}
