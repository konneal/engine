import type { SessionClaims } from "./session";
export interface RenewedSession {
    claims: Omit<SessionClaims, "iat" | "exp">;
    refreshToken: string;
}
export type RenewOutcome = {
    kind: "ok";
    renewed: RenewedSession;
} | {
    kind: "revoked";
} | {
    kind: "unavailable";
};
export declare function retainRefreshToken(env: any, sessionRaw: string, refreshToken: string): Promise<void>;
export declare function renewSessionClaims(env: any, cfg: {
    issuer: string;
    clientId: string;
    clientSecret?: string;
    sessionSecret: string;
}, session: SessionClaims, sessionRaw: string): Promise<RenewOutcome>;
