export interface DraftSample {
    serial: string;
    condition?: string;
}
export interface ApplicationPrefillFields {
    /** the Recommendation, as the estate URN (urn:oiml:pub:r:60:2021) */
    standard_doc: string;
    /** display label ("ACME AB 99:2019") */
    standard_label?: string;
    family_designation?: string;
    group_label?: string;
    model_designation?: string;
    description?: string;
    samples?: DraftSample[];
    scheme?: "A" | "B";
}
export interface DraftDrop {
    field: string;
    value: string;
    reason: string;
}
export interface DraftAct {
    kind: "draft";
    act: "application_prefill";
    version: 1;
    title: string;
    prepared_at: string;
    /** ALWAYS true — the draft is an input to the real form, never a
     *  channel; the user's own click is the only commit. */
    requires_confirmation: true;
    fields: ApplicationPrefillFields;
    dropped?: DraftDrop[];
    notes?: string[];
}
export interface DraftCitation {
    docidentifier: string;
    edition?: string;
    status?: string;
}
export type DraftRefusalReason = "sign_in_required" | "not_configured" | "window_expired" | "exchange_refused" | "role_refused" | "standard_unresolved" | "extraction_failed";
export type DraftVerdict = {
    status: "draft";
    draft: DraftAct;
    answer: string;
    citation: DraftCitation | null;
} | {
    status: "refused";
    reason: DraftRefusalReason;
    answer: string;
    citation: DraftCitation | null;
};
/** The delegation outcome the ask handler computed (livedata.ts's
 *  exchange; this module never performs it). */
export type DraftDelegation = {
    status: "ok";
    token: string;
} | {
    status: "unsigned" | "not_configured" | "window_expired" | "refused" | "op_unreachable";
};
export interface PrepareOpts {
    act: "application_prefill";
    query: string;
    history: Array<{
        role: string;
        content: string;
    }>;
    member: {
        sub: string;
    } | null;
    delegation: DraftDelegation;
    /** the platform's client id at the OP (the service_roles key) */
    platformClientId?: string;
    /** the extraction model (the cheap understand lane) */
    model: string;
}
/** The draft intent, or null. "What documents does an application
 *  need?" and "where is my application?" never trigger — no act verb. */
export declare function detectDraftIntent(query: string): "application_prefill" | null;
interface Extraction {
    standard?: string;
    family_designation?: {
        value?: string;
        source?: string;
    };
    group_label?: {
        value?: string;
        source?: string;
    };
    model_designation?: {
        value?: string;
        source?: string;
    };
    description?: {
        value?: string;
        source?: string;
    };
    scheme?: {
        value?: string;
        source?: string;
    };
    samples?: Array<{
        serial?: string;
        condition?: string;
        source?: string;
    }>;
}
/** The traceability primitive, shared with the api_call act's body guard
 *  (apicalls.ts): a value traces when it appears in the user's own
 *  messages (normalized). The proposing model never gets the benefit of
 *  the doubt — the user's words are the only source. */
export declare function valueTracesToUser(value: unknown, userTurns: string[]): boolean;
export interface GuardedFields {
    standard?: string;
    family_designation?: string;
    group_label?: string;
    model_designation?: string;
    description?: string;
    scheme?: "A" | "B";
    samples?: DraftSample[];
}
/**
 * THE GUARD: a proposed field rides the draft only when its source span
 * appears in the user's own messages AND the value appears in the span —
 * the proposal must be the user's words, never the model's completion.
 * Every rejection is a named drop (the answer accounts for each). */
export declare function traceabilityGuard(extraction: Extraction, userTurns: string[]): {
    kept: GuardedFields;
    dropped: DraftDrop[];
};
/** The draft act's full path: the member gate → the delegation's honest
 *  states → the role permission (the platform's vocabulary) → the
 *  extraction → the guard → the registry anchor → the draft. */
export declare function prepareDraft(env: any, opts: PrepareOpts): Promise<DraftVerdict>;
export {};
