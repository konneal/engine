// The delegated bearer (TODO.ai-platform/12 — the session bridge): the
// platform-embedded bubble rides the app's own OIDC session. The
// platform's same-origin proxy exchanges the retained OP access token
// (RFC 8693, the identity RP guide §9b) and forwards the ask with the
// OP-minted delegated JWT as the Bearer. This module admits THAT
// credential as the member principal:
//
//   - verified against the OP's JWKS — signature, issuer, expiry
//     (oidc.ts's verifier; discovery + JWKS ride the shared caches);
//   - the delegation marker is REQUIRED: act.sub names the delegating
//     surface (the platform instance's OP client), and the deployment
//     declares the surfaces it trusts (publisher.identity.delegators) —
//     a plain access token without the act claim is NOT a member
//     credential here; the delegation is the contract;
//   - the JWT's sub is the user; the standing re-judgment stays ours —
//     the roles cone honored is THIS service's
//     (service_roles[<our client id>] when the exchange scoped us in),
//     never the delegator's.
//
// Every failure resolves to null — the anonymous tier, never an error
// page. The feature is profile-gated (publisher.features.delegated_bearer):
// the standalone site's own session bridge is untouched by default.

import { discoverIssuer, verifyJwtSignature } from "./oidc.ts";
import { P } from "./profile.ts";
import type { SessionClaims } from "./session.ts";

const EXPIRY_LEEWAY_MS = 60_000;

/** The delegated JWT's claim shape (the OP's delegationTokenClaims):
 *  sub the user, aud the scoped services, scope the granted cone,
 *  service_roles per service, act.sub the delegating client. */
interface DelegatedJwtClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  iat?: number;
  exp?: number;
  scope?: string;
  name?: string;
  email?: string;
  service_roles?: Record<string, unknown>;
  act?: { sub?: unknown };
}

export async function delegatedBearerFrom(req: Request, env: any): Promise<SessionClaims | null> {
  if (!P().publisher.features?.delegated_bearer) return null;
  const issuer = (env.OIDC_ISSUER ?? "").trim();
  if (!issuer) return null;
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  // the service session is a two-segment HMAC token; three segments mark
  // the JWT candidate (anything else never reaches the verifier)
  if (token.split(".").length !== 3) return null;
  // fail closed: a deployment opting in names its delegating surfaces
  const delegators = P().publisher.identity?.delegators;
  if (!Array.isArray(delegators) || delegators.length === 0) return null;
  try {
    const meta = await discoverIssuer(issuer);
    const { claims } = await verifyJwtSignature(token, meta.jwks_uri);
    const c = claims as DelegatedJwtClaims;
    if (c.iss?.replace(/\/$/, "") !== meta.issuer.replace(/\/$/, "")) return null;
    if (typeof c.exp !== "number" || c.exp * 1000 + EXPIRY_LEEWAY_MS < Date.now()) return null;
    const actSub = typeof c.act?.sub === "string" ? c.act.sub : null;
    if (!actSub || !delegators.includes(actSub)) return null;
    if (typeof c.sub !== "string" || !c.sub) return null;
    const ourRoles = c.service_roles?.[env.OIDC_CLIENT_ID];
    return {
      sub: c.sub,
      name: typeof c.name === "string" ? c.name : undefined,
      email: typeof c.email === "string" ? c.email : undefined,
      roles: Array.isArray(ourRoles) ? ourRoles.filter((r): r is string => typeof r === "string") : [],
      iat: typeof c.iat === "number" ? c.iat * 1000 : Date.now(),
      exp: c.exp * 1000,
      scope: typeof c.scope === "string" ? c.scope : undefined,
      via: "delegated",
      delegator: actSub,
    };
  } catch {
    return null;
  }
}
