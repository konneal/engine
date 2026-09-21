export interface RequestScope {
    /** dataset ids the request may search */
    scopeIds: string[];
    /** corpus values the scope maps to (for the corpus-scope stage) */
    corpora: Set<string>;
    /** true when the scope is narrower than the session default — the
     *  stage only runs when narrowed (the default costs nothing) */
    narrowed: boolean;
    /** ISO federation on? (gates the internal binding) */
    isoOn: boolean;
    /** raw (validated) memory ids from the body — empty for anon */
    memoryIds: string[];
    /** raw (validated) license entitlement keys from the body — empty for
     *  anon and for requests that carry none (TODO.external-refs/08) */
    standardKeys: Set<string>;
}
/** The deployment's declared licensed standards (profile sources.yaml
 *  `licensed:` — key/package/doc_number rows). Empty = the deployment
 *  serves public content only and the entitlement scope is inert. */
export declare function licenseDeclared(): boolean;
/** The request's entitlement set, VALIDATED against the declared
 *  whitelist: unknown keys drop (a forged key can never widen scope past
 *  the standards the deployment actually keys). Absent field = empty set
 *  — the fail-closed default for a deployment that declares licensed
 *  content. */
export declare function standardKeysFrom(body: any): Set<string>;
/** The RetrieveOptions value for the hard scope: null when the
 *  deployment declares no licensed content (inert — zero behavior
 *  change); otherwise the caller's validated set, EMPTY INCLUDED (the
 *  unentitled caller: licensed chunks hidden, citation metadata stays). */
export declare function entitlementScope(keys: Set<string>): Set<string> | null;
/** Validate + intersect. Returns { error } when the request explicitly
 *  disables every dataset (a user error, not a scope). The corpora a
 *  dataset searches travel WITH the declaration (profile datasets.yaml,
 *  `corpora:`) — the engine maps no publisher names. */
export declare function resolveRequestScope(body: any, member: unknown): RequestScope | {
    error: "empty-datasets";
};
/** The answer-cache salt: request-scoped context that materially changes
 *  the answer (dataset scope, memory selection, license entitlements —
 *  the licensed tier changes the grounding, so two callers asking the
 *  same question must never share an entry). Requests differing only in
 *  salt share query text — an unsalted key would serve a scoped (or
 *  memory-flavored, or licensed-tier) answer to a plain ask. Null =
 *  default scope, no memory, no entitlement effect: keys stay
 *  byte-identical to the pre-salt era. */
export declare function requestSalt(scope: RequestScope, memoryUsed: string[]): string | null;
