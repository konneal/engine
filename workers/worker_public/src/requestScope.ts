// The per-request scope model (MECE: ask.ts orchestrates, this module
// owns the derivation): which DATASETS the request searches (the sidebar
// toggles, server-intersected with session permissions), which memory
// files ride it, and which LICENSED standards the caller's organization
// is entitled to — plus the answer-cache SALT all three selections
// produce. Pure: D1 access stays with the caller (memoryNote); this
// module only derives.
import { DATASETS, datasetAllowed } from "./config.ts";
import { P } from "./profile.ts";

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
export function licenseDeclared(): boolean {
  return (P().sources?.licensed?.length ?? 0) > 0;
}

/** The request's entitlement set, VALIDATED against the declared
 *  whitelist: unknown keys drop (a forged key can never widen scope past
 *  the standards the deployment actually keys). Absent field = empty set
 *  — the fail-closed default for a deployment that declares licensed
 *  content. */
export function standardKeysFrom(body: any): Set<string> {
  const declared = new Set<string>((P().sources?.licensed ?? []).map((l: any) => String(l.key)));
  const raw = Array.isArray(body?.licensed_standards) ? body.licensed_standards : [];
  return new Set(
    raw.filter((x: unknown): x is string => typeof x === "string" && declared.has(x)),
  );
}

/** The RetrieveOptions value for the hard scope: null when the
 *  deployment declares no licensed content (inert — zero behavior
 *  change); otherwise the caller's validated set, EMPTY INCLUDED (the
 *  unentitled caller: licensed chunks hidden, citation metadata stays). */
export function entitlementScope(keys: Set<string>): Set<string> | null {
  return licenseDeclared() ? keys : null;
}

/** Validate + intersect. Returns { error } when the request explicitly
 *  disables every dataset (a user error, not a scope). The corpora a
 *  dataset searches travel WITH the declaration (profile datasets.yaml,
 *  `corpora:`) — the engine maps no publisher names. */
export function resolveRequestScope(body: any, member: unknown): RequestScope | { error: "empty-datasets" } {
  const allIds = DATASETS().map((d) => d.id);
  const requested = Array.isArray(body?.datasets)
    ? (body.datasets as unknown[]).filter((x): x is string => typeof x === "string" && allIds.includes(x))
    : null;
  if (requested !== null && requested.length === 0) return { error: "empty-datasets" };
  const permittedIds = allIds.filter((id) => {
    const d = DATASETS().find((x) => x.id === id)!;
    return d.session ? datasetAllowed(d, member) : true;
  });
  // requested ∩ permitted — an explicit request NEVER widens past the
  //  session's permissions (a member without ai-preview asking
  //  datasets:["iso"] intersects to nothing, exactly like the default
  //  path; the intersection, not the caller, is the gate)
  const scopeIds = (requested ?? permittedIds).filter((id) => permittedIds.includes(id));
  const corpora = new Set<string>();
  for (const id of scopeIds) {
    const d = DATASETS().find((x) => x.id === id);
    for (const v of d?.corpora ?? [id]) corpora.add(v);
  }
  const memoryIds = member && Array.isArray(body?.memories)
    ? (body.memories as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 4)
    : [];
  return {
    scopeIds,
    corpora,
    narrowed: scopeIds.length < permittedIds.length,
    // federation flag: any session-gated (federated) dataset in scope
    isoOn: scopeIds.some((id) => DATASETS().find((x) => x.id === id)?.session === true),
    memoryIds,
    standardKeys: standardKeysFrom(body),
  };
}

/** The answer-cache salt: request-scoped context that materially changes
 *  the answer (dataset scope, memory selection, license entitlements —
 *  the licensed tier changes the grounding, so two callers asking the
 *  same question must never share an entry). Requests differing only in
 *  salt share query text — an unsalted key would serve a scoped (or
 *  memory-flavored, or licensed-tier) answer to a plain ask. Null =
 *  default scope, no memory, no entitlement effect: keys stay
 *  byte-identical to the pre-salt era. */
export function requestSalt(scope: RequestScope, memoryUsed: string[]): string | null {
  const licensed = licenseDeclared();
  if (!scope.narrowed && !memoryUsed.length && !licensed) return null;
  return JSON.stringify({
    ...(scope.narrowed ? { d: [...scope.corpora].sort() } : {}),
    ...(memoryUsed.length ? { m: [...memoryUsed].sort() } : {}),
    // the entitlement set rides whenever the deployment keys content at
    // all — an unentitled ask and an entitled ask of the same text are
    // different answers even when the set is empty
    ...(licensed ? { s: [...scope.standardKeys].sort() } : {}),
  });
}
