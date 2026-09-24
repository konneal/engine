export interface LiveDataConfig {
    /** The platform instance's API base (the hub's origin). */
    platformApi: string;
    /** The platform's client id at the OP (the delegation's scope target
     *  + the exchanged token's audience). */
    platformClientId: string;
    /** The OP's issuer (the exchange endpoint lives there). */
    issuer: string;
    /** THIS service's client credentials (the delegation's caller auth —
     *  the subject token binds to the client it was issued to). */
    clientId: string;
    clientSecret?: string;
}
export declare function liveDataConfig(env: any): LiveDataConfig | null;
export declare function retainRefreshToken(env: any, sessionRaw: string, refreshToken: string): Promise<void>;
export declare function readRefreshToken(env: any, sessionRaw: string): Promise<string | null>;
export declare function dropRefreshToken(env: any, sessionRaw: string): Promise<void>;
export declare function retainOpAccessToken(env: any, sessionRaw: string, opAccessToken: string, expiresInSec: number): Promise<void>;
/** Drop the retained subject + the cached exchanged token (the sign-out
 *  closes the window deliberately, never by expiry alone). */
export declare function dropOpAccessToken(env: any, sessionRaw: string): Promise<void>;
export type LiveTokenVerdict = {
    ok: true;
    token: string;
} | {
    ok: false;
    reason: "not_configured" | "window_expired" | "refused" | "op_unreachable";
};
/** Exchange the session's retained OP access token for the
 *  platform-scoped JWT (identity's §9b). The exchanged token caches for
 *  its own short life; the refusal lattice is honest per leg. */
export declare function exchangeForLiveToken(env: any, sessionRaw: string): Promise<LiveTokenVerdict>;
export interface LiveRecord {
    /** the platform store the record came from */
    store: string;
    id: string;
    /** the display label ("Application APP-2026-001 — R 60") */
    label: string;
    /** the platform page the record links to */
    url: string;
    status?: string;
    date?: string;
    /** the coarse one-line state ("evaluation in progress", "3 test
     *  requests dispatched") — the progress projection's summary */
    detail?: string;
}
export type LiveRead = {
    ok: true;
    records: LiveRecord[];
    stores: string[];
    readAt: string;
} | {
    ok: false;
    reason: "platform_refused" | "platform_unreachable";
};
/** Read the account's live surface: the bounded store lists (the cone
 *  filters server-side — a refused store contributes NOTHING, never an
 *  error into the answer) + the progress projection for the freshest
 *  applications. Every record maps 1:1 from a platform row. */
export declare function readMyAccount(_env: any, cfg: LiveDataConfig, token: string): Promise<LiveRead>;
export type LiveAccount = {
    status: "ok";
    records: LiveRecord[];
    stores: string[];
    readAt: string;
} | {
    status: "unavailable";
    reason: "sign_in_required" | "not_configured" | "window_expired" | "refused" | "op_unreachable" | "platform_refused" | "platform_unreachable";
};
/** Resolve the "my account" context for one ask: the member's session →
 *  the exchange → the platform reads. Every failure is an honest reason
 *  the context line can state — never a silent widening, never an
 *  invented record. */
export declare function resolveLiveAccount(env: any, sessionRaw: string | null, member: {
    sub: string;
} | null): Promise<LiveAccount>;
