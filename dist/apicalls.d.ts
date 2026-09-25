import { type DeclaredContext } from "./context.ts";
export interface ApiCall {
    method: "POST" | "PUT" | "PATCH" | "DELETE" | "GET";
    path: string;
    body?: unknown;
}
export interface ApiCallDraft {
    kind: "draft";
    act: "api_call";
    version: 1;
    title: string;
    prepared_at: string;
    /** ALWAYS true — the card's tap (or the standing grant, for the
     *  preference family) is the only authority that executes. */
    requires_confirmation: true;
    call: ApiCall;
    notes?: string[];
}
export type ApiCallRefusalReason = "sign_in_required" | "machine_read_only" | "no_matching_act" | "entity_unresolved" | "operation_unknown" | "operation_never_offered" | "body_untraced" | "pick_failed";
export type ApiCallVerdict = {
    status: "draft";
    draft: ApiCallDraft;
    answer: string;
} | {
    status: "refused";
    reason: ApiCallRefusalReason;
    answer: string;
};
/** A target the assistant never proposes: the never-offer prefixes match
 *  the operation's declared (templated) path. */
export declare function neverOffered(path: string): boolean;
export interface ApiOp {
    operation_id: string;
    method: string;
    path: string;
    act_class: string | null;
    summary: string | null;
    tag: string | null;
}
/** Parse the declared context's route against the profile's entity-route
 *  patterns (`/a/b/:id` segments; the LAST parameter captures the entity
 *  id). Returns the store + id the entity write addresses, or null — a
 *  route the table does not cover is an honest unresolved, never a guess. */
export declare function resolveEntityRoute(route: string | undefined): {
    store: string;
    id: string;
} | null;
export type ApiCallIntent = "machine_act" | "preference";
/** Which api_call family the ask aims at, or null. The machine facet
 *  decides the machine family (no facet = no machine act, whatever the
 *  verbs); the preference family needs no facet. */
export declare function detectApiCallIntent(query: string, declared: DeclaredContext | null): ApiCallIntent | null;
/** The body guard: every string value traces to the user's own words
 *  (the never-invents doctrine, drafts.ts's primitive). Scalars the user
 *  toggles (booleans, numbers) pass — they state no fact. */
export declare function bodyTraces(body: unknown, userTurns: string[]): boolean;
export interface ApiCallPrepareOpts {
    intent: ApiCallIntent;
    query: string;
    history: Array<{
        role: string;
        content: string;
    }>;
    member: {
        sub: string;
    } | null;
    declared: DeclaredContext | null;
    /** the intent-mapping model (the profile's pick — the operations
     *  deployment runs the stronger reasoning tier here) */
    model: string;
}
export declare function prepareApiCall(env: any, opts: ApiCallPrepareOpts): Promise<ApiCallVerdict>;
