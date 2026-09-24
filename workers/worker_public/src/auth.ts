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
  fetchUserinfo,
  OidcError,
} from "./oidc";
import { clearSessionCookie, mintSessionCookie, mintSessionToken, rawSessionToken, readSession, sessionCookieFromToken, SessionClaims } from "./session";
import { renewSessionClaims, retainRefreshToken } from "./oidc-refresh";
import { bubbleConfirmPage, isAllowedBubbleOrigin } from "./bubble";
import { dropOpAccessToken, retainOpAccessToken } from "./livedata";

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
  origin_not_allowed: "That site may not connect the assistant to your account.",
};

function authErrorText(reason: string): string {
  return PLAIN_LANGUAGE[reason] ?? "Sign-in failed. Please try again.";
}

// Two tiers only: anonymous (public index) and member (both indexes).
// Estate roles (mc_member, etc.) are identity claims, NOT access gates
// here — any authenticated user is a member.
export interface AuthConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  sessionSecret: string;
}

// how long a session serves before renewal re-judges it against the OP
const RENEW_AFTER_MS = 60 * 60 * 1000;

function authConfig(env: any): AuthConfig | null {
  const issuer = (env.OIDC_ISSUER ?? "").trim().replace(/\/$/, "");
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
  // Bubble bridge (bubble.ts): the embedded panel's sign-in. The origin
  // is validated NOW, at flow start, and bound to the state — the
  // callback hands the session token to exactly that origin, never to
  // wherever the request happens to come from later.
  const url0 = new URL(req.url);
  const bubbleMode = url0.searchParams.get("mode") === "bubble";
  const bubbleOrigin = url0.searchParams.get("origin") ?? "";
  if (bubbleMode && !isAllowedBubbleOrigin(bubbleOrigin)) return redirectWithError("origin_not_allowed");
  try {
    const meta = await discoverIssuer(cfg.issuer);
    const state = randomToken();
    const nonce = randomToken();
    const pkce = await generatePkce();
    await env.CACHE.put(
      `oa:${state}`,
      JSON.stringify({ nonce, verifier: pkce.verifier, ...(bubbleMode ? { mode: "bubble", origin: bubbleOrigin } : {}) }),
      {
        expirationTtl: 600,
      },
    );
    const silent = url0.searchParams.get("prompt") === "none";
    const url = buildAuthorizationUrl(meta, {
      clientId: cfg.clientId,
      redirectUri: cfg.redirectUri,
      scopes: "openid profile email roles offline_access",
      state,
      nonce,
      codeChallenge: pkce.challenge,
      // silent SSO: the OP answers from its existing session or errors
      // login_required — the callback then lands quietly, signed in or
      // still anonymous, and the estate session carries to this site
      // without a click
      ...(silent ? { prompt: "none" } : {}),
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
  if (opError === "login_required") {
    // the silent probe found no OP session — anonymous is the honest
    // state, never an error
    return new Response(null, { status: 302, headers: { location: "/?auth_silent=none" } });
  }
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
    // `picture` is a userinfo claim on this OP (the ID token carries the
    // profile contract only) — fall back to userinfo, sub-checked, when
    // the token happens to omit it
    let picture = typeof claims.picture === "string" ? claims.picture : undefined;
    if (!picture && typeof token.access_token === "string") {
      const ui = await fetchUserinfo(meta, token.access_token);
      if (ui.sub === claims.sub && typeof ui.picture === "string" && ui.picture) picture = ui.picture;
    }
    const sessionClaims = {
      sub: claims.sub,
      name: typeof claims.name === "string" ? claims.name : undefined,
      email: typeof claims.email === "string" ? claims.email : undefined,
      picture,
      roles,
    };
    // Mint ONCE — the cookie and the bubble's Bearer carry the same
    // session token, so the live-data window (TODO.ai-platform/03) keyed
    // off it holds for both presentations.
    const session = await mintSessionToken(cfg.sessionSecret, sessionClaims);
    const cookie = sessionCookieFromToken(session.token);
    // TODO.ai-platform/03: retain the OP access token for the session's
    // exchange window (the "my account" live-data delegation exchanges
    // it per the identity service's RFC 8693 §9b) — KV only, TTL = the
    // OP token's own life, never D1, never past the window.
    if (typeof token.access_token === "string" && typeof token.expires_in === "number") {
      await retainOpAccessToken(env, session.token, token.access_token, token.expires_in);
    }
    // the session's lifeline (oidc-refresh.ts): the OP's refresh token
    // is what makes renewal a RE-JUDGMENT instead of a re-stamp
    if (typeof token.refresh_token === "string" && token.refresh_token) {
      await retainRefreshToken(env, session.token, token.refresh_token);
    }
    // Bubble bridge: hand the session to the embedded panel as a Bearer
    // token via the confirm page — postMessage to the validated origin
    // ONLY, and only on the user's explicit click (bubble.ts). The
    // cookie still sets, so ai.oimlsmart.org itself is signed in too.
    if (stored.mode === "bubble" && typeof stored.origin === "string" && isAllowedBubbleOrigin(stored.origin)) {
      return new Response(
        bubbleConfirmPage({
          name: sessionClaims.name ?? sessionClaims.email ?? "member",
          origin: stored.origin,
          token: session.token,
          expiresAt: session.expiresAt,
        }),
        { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "set-cookie": cookie } },
      );
    }
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
  // Renewal is a RE-JUDGMENT, not a re-stamp (oidc-refresh.ts): a
  // session older than the threshold presents the OP's refresh token,
  // whose grant re-judges the live standing — a deactivated account's
  // grant family is dead, the OP refuses, and the session ENDS here
  // instead of silently serving stale claims for a week. A session with
  // no stored refresh token (pre-offline_access logins) falls back to
  // the legacy re-stamp; a network refusal keeps the session and
  // retries on the next load.
  let effective: SessionClaims | null = session;
  if (session && cfg && Date.now() - session.iat > RENEW_AFTER_MS) {
    const raw = rawSessionToken(req);
    if (raw) {
      const renewed = await renewSessionClaims(env, { issuer: cfg.issuer, clientId: cfg.clientId, clientSecret: env.OIDC_CLIENT_SECRET, sessionSecret: cfg.sessionSecret }, session, raw);
      if (renewed.kind === "ok") {
        const freshClaims = renewed.renewed.claims;
        const minted = await mintSessionToken(cfg.sessionSecret, freshClaims);
        effective = { ...freshClaims, iat: Date.now(), exp: minted.expiresAt };
        headers["set-cookie"] = sessionCookieFromToken(minted.token);
      } else if (renewed.kind === "revoked") {
        effective = null;
        headers["set-cookie"] = clearSessionCookie();
      }
    }
  }
  if (effective && cfg && session && effective === session && Date.now() - session.iat > 24 * 3600 * 1000) {
    // the legacy re-stamp: no refresh token available (pre-offline_access
    // sessions) — the claims are what they were, but the 7-day wall still
    // slides for active users
    headers["set-cookie"] = await mintSessionCookie(cfg.sessionSecret, {
      sub: session.sub,
      name: session.name,
      email: session.email,
      picture: session.picture,
      roles: session.roles,
    });
  }
  return new Response(
    JSON.stringify({
      authenticated: !!effective,
      name: effective?.name ?? null,
      email: effective?.email ?? null,
      picture: effective?.picture ?? null,
      roles: effective?.roles ?? [],
      tier: effective ? "member" : "anon",
      sign_in_available: !!cfg,
    }),
    { headers },
  );
}

export async function handleLogout(env: any, req: Request): Promise<Response> {
  const cfg = authConfig(env);
  const headers: Record<string, string> = { "set-cookie": clearSessionCookie() };
  // The live-data window closes WITH the session (TODO.ai-platform/03 —
  // deliberately, never by the TTL alone).
  const presented = rawSessionToken(req);
  if (presented) await dropOpAccessToken(env, presented);
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
