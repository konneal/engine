import type { OidcIdTokenClaims, OidcTokenResponse } from "./oidc.ts";
import type { SessionClaims } from "./session";
export interface OidcMetadata {
    token_endpoint: string;
    jwks_uri: string;
}
export type RefreshResult = {
    kind: "ok";
    token: OidcTokenResponse;
} | {
    kind: "refused";
} | {
    kind: "unavailable";
};
/** The refresh grant's backchannel: the same shape as the code
 *  exchange's POST (the OP's WAF wants the issuer's own origin), with
 *  the three outcomes the renewal policy needs — a 400 is the OP
 *  REFUSING (revocation, expiry: dead), a network throw is
 *  unavailability (keep the session, retry next load). */
export declare function refreshGrant(meta: OidcMetadata, cfg: {
    clientId: string;
    clientSecret?: string;
}, refreshToken: string): Promise<RefreshResult>;
/** The fresh session claims from the refresh grant's ID token. The sub
 *  MUST match (a different account is a provisioning error, never an
 *  update); every profile field falls back to the standing session's so
 *  a claim the OP omits never erases what the user already had. */
export declare function renewedSessionClaims(session: SessionClaims, claims: OidcIdTokenClaims): Omit<SessionClaims, "iat" | "exp"> | null;
