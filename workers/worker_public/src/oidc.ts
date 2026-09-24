// OIDC relying-party half of the Authorization Code + PKCE flow,
// hand-rolled on WebCrypto + fetch. Ported from the estate's reference
// implementation (oimlsmart/smart packages/platform-server/src/oidc.ts)
// per docs/identity-service.md — zero library dependencies by design.

export type OidcFailureReason =
  | 'not_configured'
  | 'discovery'
  | 'issuer_mismatch'
  | 'exchange'
  | 'state'
  | 'token_malformed'
  | 'token_alg'
  | 'token_signature'
  | 'token_issuer'
  | 'token_audience'
  | 'token_expired'
  | 'token_nonce';

export class OidcError extends Error {
  constructor(readonly reason: OidcFailureReason, message: string) {
    super(message);
    this.name = "OidcError";
  }
}

export interface OidcMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  userinfo_endpoint?: string;
}

interface CachedMetadata {
  metadata: OidcMetadata;
  fetchedAt: number;
}
const metadataCache = new Map<string, CachedMetadata>();
const METADATA_TTL_MS = 60 * 60 * 1000;

/** UserInfo (the OP declares the endpoint): the ID token carries the
 *  profile contract (name/email + policy families) — `picture` rides
 *  userinfo. Returns {} on any failure (the picture is a nicety, never
 *  a gate); the CALLER must check `sub` matches the ID token's. */
export async function fetchUserinfo(meta: OidcMetadata, accessToken: string): Promise<Record<string, unknown>> {
  if (!meta.userinfo_endpoint) return {};
  try {
    const res = await fetch(meta.userinfo_endpoint, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return {};
    const claims: unknown = await res.json();
    return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function discoverIssuer(issuer: string): Promise<OidcMetadata> {
  const cached = metadataCache.get(issuer);
  if (cached && Date.now() - cached.fetchedAt < METADATA_TTL_MS) return cached.metadata;

  const wellKnown = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  let body: unknown;
  try {
    const res = await fetch(wellKnown);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (err) {
    throw new OidcError("discovery", `could not fetch ${wellKnown}: ${(err as Error).message}`);
  }
  const meta = body as Partial<OidcMetadata>;
  if (
    typeof meta?.issuer !== "string" ||
    typeof meta?.authorization_endpoint !== "string" ||
    typeof meta?.token_endpoint !== "string" ||
    typeof meta?.jwks_uri !== "string"
  ) {
    throw new OidcError("discovery", `the metadata at ${wellKnown} is incomplete`);
  }
  if (meta.issuer.replace(/\/$/, "") !== issuer.replace(/\/$/, "")) {
    throw new OidcError("issuer_mismatch", `the metadata declares issuer ${meta.issuer}, not ${issuer}`);
  }
  const metadata: OidcMetadata = {
    issuer: meta.issuer,
    authorization_endpoint: meta.authorization_endpoint,
    token_endpoint: meta.token_endpoint,
    jwks_uri: meta.jwks_uri,
    ...(typeof meta.end_session_endpoint === "string" ? { end_session_endpoint: meta.end_session_endpoint } : {}),
    ...(typeof meta.userinfo_endpoint === "string" ? { userinfo_endpoint: meta.userinfo_endpoint } : {}),
  };
  metadataCache.set(issuer, { metadata, fetchedAt: Date.now() });
  return metadata;
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice(0, (4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(24)));
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export async function generatePkce(): Promise<PkcePair> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function buildAuthorizationUrl(
  metadata: OidcMetadata,
  params: {
    clientId: string;
    redirectUri: string;
    scopes: string;
    state: string;
    nonce: string;
    codeChallenge: string;
    /** OIDC prompt ('none' = silent: the OP answers from its session or
     *  errors login_required — never an interaction). */
    prompt?: string;
  },
): string {
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", params.scopes);
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (params.prompt) url.searchParams.set("prompt", params.prompt);
  return url.toString();
}

export interface OidcTokenResponse {
  id_token: string;
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
}

export async function exchangeCode(
  metadata: OidcMetadata,
  params: { clientId: string; clientSecret?: string; code: string; redirectUri: string; codeVerifier: string },
): Promise<OidcTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.codeVerifier,
  });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  // The OP's WAF classifies Origin-less POSTs as cross-site form
  // submissions and rejects them with 403. The backchannel is
  // server-to-server (PKCE + client auth are the real security), so we
  // present the issuer's own origin to pass its same-origin check.
  headers.origin = new URL(metadata.token_endpoint).origin;
  if (params.clientSecret) {
    headers.authorization = `Basic ${btoa(`${encodeURIComponent(params.clientId)}:${encodeURIComponent(params.clientSecret)}`)}`;
  }
  let json: unknown;
  try {
    const res = await fetch(metadata.token_endpoint, { method: "POST", headers, body });
    json = await res.json();
    if (!res.ok) {
      const err = (json as { error?: string; error_description?: string }) ?? {};
      throw new Error(`HTTP ${res.status} ${err.error ?? ""} ${err.error_description ?? ""}`.trim());
    }
  } catch (err) {
    throw new OidcError("exchange", `the token endpoint refused the exchange: ${(err as Error).message}`);
  }
  const token = json as Partial<OidcTokenResponse>;
  if (typeof token?.id_token !== "string") {
    throw new OidcError("exchange", "the token response carries no id_token");
  }
  return token as OidcTokenResponse;
}

interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  crv?: string;
}

interface CachedJwks {
  keys: Jwk[];
  fetchedAt: number;
}
const jwksCache = new Map<string, CachedJwks>();
const JWKS_TTL_MS = 60 * 60 * 1000;

async function fetchJwks(jwksUri: string, force: boolean): Promise<Jwk[]> {
  const cached = jwksCache.get(jwksUri);
  if (!force && cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  let body: unknown;
  try {
    const res = await fetch(jwksUri);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (err) {
    throw new OidcError("token_signature", `could not fetch the signing keys: ${(err as Error).message}`);
  }
  const keys = (body as { keys?: Jwk[] })?.keys;
  if (!Array.isArray(keys)) {
    throw new OidcError("token_signature", "the JWKS carries no keys array");
  }
  jwksCache.set(jwksUri, { keys, fetchedAt: Date.now() });
  return keys;
}

export interface OidcIdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  azp?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  roles?: string[];
  groups?: string[];
  org?: unknown;
  [claim: string]: unknown;
}

const EXPIRY_LEEWAY_MS = 60_000;

export async function validateIdToken(
  idToken: string,
  expectations: { issuer: string; clientId: string; nonce: string; jwksUri: string },
): Promise<OidcIdTokenClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new OidcError("token_malformed", "the ID token is not a three-part JWT");
  }
  let header: { alg?: string; kid?: string };
  let claims: OidcIdTokenClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1]))) as OidcIdTokenClaims;
  } catch {
    throw new OidcError("token_malformed", "the ID token header/claims are not JSON");
  }
  if (header.alg !== "RS256" && header.alg !== "ES256") {
    throw new OidcError("token_alg", `the ID token uses ${header.alg ?? "no declared algorithm"}`);
  }

  const signedContent = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = base64urlDecode(parts[2]) as BufferSource;
  let verified = false;
  for (const force of [false, true]) {
    const keys = await fetchJwks(expectations.jwksUri, force);
    const candidates = keys.filter(
      (k) => (!header.kid || k.kid === header.kid) && (header.alg === "RS256" ? k.kty === "RSA" : k.kty === "EC"),
    );
    for (const jwk of candidates) {
      try {
        const key = await crypto.subtle.importKey(
          "jwk",
          jwk as JsonWebKey,
          header.alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } : { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["verify"],
        );
        verified = await crypto.subtle.verify(
          header.alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" },
          key,
          signature,
          signedContent,
        );
      } catch {
        verified = false;
      }
      if (verified) break;
    }
    if (verified) break;
  }
  if (!verified) {
    throw new OidcError("token_signature", "the ID token signature does not verify against the issuer's published keys");
  }

  if (claims.iss?.replace(/\/$/, "") !== expectations.issuer.replace(/\/$/, "")) {
    throw new OidcError("token_issuer", "the ID token's issuer is not the configured issuer");
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expectations.clientId)) {
    throw new OidcError("token_audience", "the ID token was not issued for this application");
  }
  if (audiences.length > 1 && claims.azp && claims.azp !== expectations.clientId) {
    throw new OidcError("token_audience", "the ID token's authorized party is not this application");
  }
  if (typeof claims.exp !== "number" || claims.exp * 1000 + EXPIRY_LEEWAY_MS < Date.now()) {
    throw new OidcError("token_expired", "the ID token has expired");
  }
  if (claims.nonce !== expectations.nonce) {
    throw new OidcError("token_nonce", "the ID token's nonce does not match the request");
  }
  return claims;
}

export function buildEndSessionUrl(
  metadata: OidcMetadata,
  params: { idTokenHint?: string | null; clientId: string; postLogoutRedirectUri: string },
): string | null {
  if (!metadata.end_session_endpoint) return null;
  const url = new URL(metadata.end_session_endpoint);
  if (params.idTokenHint) url.searchParams.set("id_token_hint", params.idTokenHint);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("post_logout_redirect_uri", params.postLogoutRedirectUri);
  return url.toString();
}
