export declare const MODELS: {
    readonly embed: "@cf/qwen/qwen3-embedding-0.6b";
    readonly rerank: "@cf/baai/bge-reranker-base";
    readonly anon: "@cf/zai-org/glm-5.3-flash";
    readonly member: "@cf/zai-org/glm-5.3-flash";
    readonly understand: "@cf/qwen/qwen3-30b-a3b-fp8";
    readonly fallback: "@cf/qwen/qwen3-30b-a3b-fp8";
    readonly grader: "@cf/deepseek-ai/deepseek-v4-flash-0731";
    readonly enrich: "@cf/deepseek-ai/deepseek-v4-pro-0813";
    readonly listwise: "@cf/zai-org/glm-4.7-flash";
    readonly research: "@cf/zai-org/glm-5.3-flash";
};
export declare const LIMITS: {
    readonly maxInputChars: 8000;
    readonly maxOutputTokens: 3072;
    readonly retrieveK: 50;
    readonly rerankKeep: 10;
    readonly cacheTtlSec: number;
    readonly inputTokenBudget: 16000;
    readonly maxPassageTokens: 900;
};
/** Tuned retrieval thresholds — every number the pipeline steers by.
 *  Each carries the measurement that justifies it; changing one without
 *  re-running the gates (golden ×3 + annealment ×6) is a guess. */
export declare const THRESHOLDS: {
    /** HyDE candidate score discount — hypothetical-answer vectors match
     *  differently than question vectors; 0.7 keeps them competitive
     *  without letting a bad hypothetical outrank the real query. */
    readonly hydeDiscount: 0.7;
    /** Graph-lane candidate discount — graph-filtered chunks enter the
     *  pool below the primary dense lane; they must earn their window
     *  slot under the cross-encoder, not by graph membership alone. */
    readonly graphLaneDiscount: 0.75;
    /** Concept-graph candidate discount — same rationale as the graph
     *  lane: definitional content enters discounted. */
    readonly conceptGraphDiscount: 0.75;
    /** Multi-hop sub-query discount — sub-question hits are unioned, not
     *  RRF-fused; the discount keeps them from dominating the primary
     *  ranking on their first appearance. */
    readonly subQueryDiscount: 0.8;
    /** Federated-ISO discount — the public corpus answers by default;
     *  internal ISO passages compete but don't preempt. */
    readonly federateDiscount: 0.95;
    /** Standard-reference nudge (L5): when the question asks about an
     *  invoked ISO/IEC standard, chunks that CARRY such a citation (their
     *  text contains an ISO/IEC identifier) get a spread-scaled boost —
     *  the citing clause is the answer, and generic family prose otherwise
     *  fills the window (measured: l5a-iso-humidity flips ~1/6 runs). */
    readonly stdRefNudgeSpread: 0.35;
    /** Edition cover — the score multiplier for current-edition chunks the
     *  cover stage fetches when a pool holds ONLY stale editions of a
     *  document. Just under the top: the point is REPRESENTATION (so
     *  edition steering can demote the stale siblings and diversity keeps
     *  the current overview), not free ranking. */
    readonly editionCoverDiscount: 0.9;
    /** Overview-chunk demotion — overview chunks repeat title/doctype
     *  boilerplate and embed strongly for name-like queries, crowding
     *  clause chunks out of the rerank window. */
    readonly overviewDemotion: 0.85;
    /** Glossary-link cosine floor — below this the dense match to a
     *  defined term is noise, not a candidate. Calibrated on the
     *  drifting→durability probe (durability-def 0.542, noise ~0.3). */
    readonly glossaryCosineFloor: 0.5;
    /** Exact-term nudge (spread multiplier) — clause chunks whose head IS
     *  the asked-for term get a decisive nudge because publication headers
     *  contain the title words and the reranker alone is unreliable there;
     *  >1 so it dominates the spread, unlike the additive steering boosts. */
    readonly termNudgeSpread: 1.5;
    /** Concept-steering rerank boost (spread fraction) — the vocabulary
     *  link's defining families get the edition-steering boost idiom.
     *  0.15 is enough to lift in-family content past the cross-encoder's
     *  vocabulary bias without overriding genuine relevance. */
    readonly conceptSteerSpread: 0.15;
    /** Cross-publication recency boost (spread fraction) — a
     *  current-edition publication ranks over stale ones; composed with
     *  the family-relative demotion below. */
    readonly crossPubRecencySpread: 0.1;
    /** Family-relative edition demotion (spread fraction) — superseded
     *  editions are demoted when a newer edition of the same publication
     *  is in the pool; a sibling one revision back still competes. */
    readonly familyDemoteSpread: 0.4;
    /** Relevance-floored window — passages below this fraction of the
     *  top rerank score leave the window (the evidence-budget principle;
     *  structural units are exempt). */
    readonly windowFloorFraction: 0.25;
    /** Small-to-big parent fetch discount — the parent clause enters at
     *  a discount because it's supplementary grounding, not the answer. */
    readonly smallToBigDiscount: 0.7;
    /** Section-descent child discount — children fetched from a ranked
     *  depth-1 summary enter discounted. */
    readonly sectionDescentDiscount: 0.8;
    /** History budget share — the fraction of the context budget the
     *  conversation slice may consume; older turns overflow into the
     *  compacted summary instead of starving the passages. */
    readonly historyBudgetShare: 0.3;
};
/** Process-expansion — appended to process-intent queries; publisher
 *  vocabulary from the profile (read at request time — see profile.ts). */
export declare function processExpansion(): string;
/** Per-deployment model override: <ROLE>_MODEL (e.g. UNDERSTAND_MODEL)
 *  replaces the pinned default for that role. Ops lever for A/B-ing a
 *  role's model without a code change; absent/invalid = the default. */
export declare function roleModel(env: any, role: keyof typeof MODELS): string;
/** Per-deployment effort override for the answer lane (ANSWER_EFFORT).
 *  The effort–accuracy curve is front-loaded (DeepSeek-V4.1-Flash report,
 *  Fig. 9): serving pins "low" for latency, and any move up must be
 *  measured on the golden set — this lever makes that measurable live,
 *  same pattern as roleModel. Absent/invalid = "low". */
export declare function answerEffort(env: any): string;
/** Per-request effort for the answer lane (the user-facing depth toggle).
 *  The vocabulary is validated; elevated efforts (medium+) are a member
 *  lane — same cost rule as research — and degrade to the deployment
 *  lever for anonymous or silent requests. */
/** Elevated effort reasons longer — the output budget must grow with it
 *  or reasoning starves the content (the GLM-5 rule; measured
 *  2026-09-12: medium at the flat 3072 budget scored 5/38 on the golden
 *  set — empty answers — versus 37–38/38 at low). */
export declare function effortBudget(effort: string): number;
export declare function requestEffort(env: any, session: unknown, requested: unknown): string;
/** The corpus catalog — single source for /api/datasets, the assistant's
 *  self-description, and per-corpus model guidance. `session: true`
 *  datasets are enabled for signed-in members (federated via the internal
 *  service binding). `note` (optional) is injected into the system prompt
 *  when passages from this corpus are present — corpus behavior travels
 *  with the dataset, not with pipeline code. */
export interface Dataset {
    id: string;
    label: string;
    description: string;
    /** member-session gated (federated via the internal service binding) */
    session?: boolean;
    /** the estate permission (a role code set in the publisher's
     *  identity provider) the session must carry for a session-gated
     *  dataset — membership alone is not the bar */
    permission?: string;
    /** the corpora this dataset searches (profile datasets.yaml) — the
     *  engine maps no publisher names */
    corpora?: string[];
    note?: string;
}
export declare function DATASETS(): readonly Dataset[];
/** The estate permission gate: a session-gated dataset requires BOTH
 *  membership and the named permission (a role code the account carries
 *  in id.oimlsmart.org). Enforcement is server-side — the UI's lock is
 *  cosmetic; /api/ask federation and the scope intersect here too. */
export declare function hasPermission(session: unknown, code: string): boolean;
export declare function datasetAllowed(d: Dataset, session: unknown): boolean;
export declare function datasetsFor(session: unknown): unknown[];
/** Empty-state starter questions, served by /api/datasets — UI content
 *  comes from the API, never hardcoded in the client. */
export declare function SUGGESTIONS(): string[];
export declare function num(env: Record<string, unknown>, key: string, fallback: number): number;
export declare function today(): string;
export declare function sha256Hex(s: string): Promise<string>;
