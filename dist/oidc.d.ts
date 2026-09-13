export type OidcFailureReason = 'not_configured' | 'discovery' | 'issuer_mismatch' | 'exchange' | 'state' | 'token_malformed' | 'token_alg' | 'token_signature' | 'token_issuer' | 'token_audience' | 'token_expired' | 'token_nonce';
export declare class OidcError extends Error {
    readonly reason: OidcFailureReason;
    constructor(reason: OidcFailureReason, message: string);
}
export interface OidcMetadata {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
    end_session_endpoint?: string;
    userinfo_endpoint?: string;
}
/** UserInfo (the OP declares the endpoint): the ID token carries the
 *  profile contract (name/email + policy families) — `picture` rides
 *  userinfo. Returns {} on any failure (the picture is a nicety, never
 *  a gate); the CALLER must check `sub` matches the ID token's. */
export declare function fetchUserinfo(meta: OidcMetadata, accessToken: string): Promise<Record<string, unknown>>;
export declare function discoverIssuer(issuer: string): Promise<OidcMetadata>;
export declare function randomToken(): string;
export interface PkcePair {
    verifier: string;
    challenge: string;
}
export declare function generatePkce(): Promise<PkcePair>;
export declare function buildAuthorizationUrl(metadata: OidcMetadata, params: {
    clientId: string;
    redirectUri: string;
    scopes: string;
    state: string;
    nonce: string;
    codeChallenge: string;
}): string;
export interface OidcTokenResponse {
    id_token: string;
    access_token?: string;
    token_type?: string;
    expires_in?: number;
}
export declare function exchangeCode(metadata: OidcMetadata, params: {
    clientId: string;
    clientSecret?: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
}): Promise<OidcTokenResponse>;
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
export declare function validateIdToken(idToken: string, expectations: {
    issuer: string;
    clientId: string;
    nonce: string;
    jwksUri: string;
}): Promise<OidcIdTokenClaims>;
export declare function buildEndSessionUrl(metadata: OidcMetadata, params: {
    idTokenHint?: string | null;
    clientId: string;
    postLogoutRedirectUri: string;
}): string | null;
