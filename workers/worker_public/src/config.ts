import { P } from "./profile.ts";

export const MODELS = {
  embed: "@cf/qwen/qwen3-embedding-0.6b",  rerank: "@cf/baai/bge-reranker-base",
  // ANSWER MODEL (all tiers, user decision 2026-08-29): glm-5.3-flash —
  // natively multimodal (vision-unified contract), GLM family, flash tier.
  // Vision image-parts land with answer contract v2; text answers work now.
  anon: "@cf/zai-org/glm-5.3-flash",
  member: "@cf/zai-org/glm-5.3-flash",
  // hot-path understanding/summarize stays on the cheap Qwen (cost-first lane)
  understand: "@cf/qwen/qwen3-30b-a3b-fp8",
  // generation fallback when the answer model is unavailable
  fallback: "@cf/qwen/qwen3-30b-a3b-fp8",
  grader: "@cf/deepseek-ai/deepseek-v4-flash-0731", // CRAG grader + judges (unsuffixed slug was retired → silent 5018s)
  // contextual enrichment is the QUALITY-FIRST lane (one-time spend over
  // the corpus, its quality persists into every future retrieval)
  enrich: "@cf/deepseek-ai/deepseek-v4-pro-0813",
  // final-tier listwise reranker for hard/member queries (cascade:
  // cross-encoder prunes, listwise orders jointly)
  listwise: "@cf/zai-org/glm-4.7-flash",
  // deep-research loop (G10): bounded agentic iterations, members-only
  research: "@cf/zai-org/glm-5.3-flash",
} as const;

export const LIMITS = {
  // input sizes: generous — real questions can be long (pasted scenarios,
  // multi-part asks). The context BUDGET is the real governor of what the
  // model sees; these caps only bound abuse.
  maxInputChars: 8000,
  maxOutputTokens: 3072, // qwen3-30b-a3b always reasons; 768 starved the answer entirely
  retrieveK: 50, // Vectorize caps topK at 50 when returnMetadata=all
  rerankKeep: 10, // 8 crowded out dirty-lane goldens once 3k enriched MKO clean chunks entered the pool
  cacheTtlSec: 6 * 3600,
  // context-window budget (estimated tokens) for the assembled prompt —
  // system + summary + history slice + passages must fit or the model
  // request fails. 16k is conservative for the qwen3 tier (pre-budget
  // traffic at ~12k+ never hit a length error); raise via INPUT_TOKEN_BUDGET
  // after watching logs for length rejections
  inputTokenBudget: 16000,
  maxPassageTokens: 900, // per-passage cap (clause chunks with tables can be huge)
} as const;

/** Tuned retrieval thresholds — every number the pipeline steers by.
 *  Each carries the measurement that justifies it; changing one without
 *  re-running the gates (golden ×3 + annealment ×6) is a guess. */
export const THRESHOLDS = {
  /** HyDE candidate score discount — hypothetical-answer vectors match
   *  differently than question vectors; 0.7 keeps them competitive
   *  without letting a bad hypothetical outrank the real query. */
  hydeDiscount: 0.7,
  /** Graph-lane candidate discount — graph-filtered chunks enter the
   *  pool below the primary dense lane; they must earn their window
   *  slot under the cross-encoder, not by graph membership alone. */
  graphLaneDiscount: 0.75,
  /** Concept-graph candidate discount — same rationale as the graph
   *  lane: definitional content enters discounted. */
  conceptGraphDiscount: 0.75,
  /** Multi-hop sub-query discount — sub-question hits are unioned, not
   *  RRF-fused; the discount keeps them from dominating the primary
   *  ranking on their first appearance. */
  subQueryDiscount: 0.8,
  /** Federated-ISO discount — the public corpus answers by default;
   *  internal ISO passages compete but don't preempt. */
  federateDiscount: 0.95,
  /** Standard-reference nudge (L5): when the question asks about an
   *  invoked ISO/IEC standard, chunks that CARRY such a citation (their
   *  text contains an ISO/IEC identifier) get a spread-scaled boost —
   *  the citing clause is the answer, and generic family prose otherwise
   *  fills the window (measured: l5a-iso-humidity flips ~1/6 runs). */
  stdRefNudgeSpread: 0.35,
  /** Edition cover — the score multiplier for current-edition chunks the
   *  cover stage fetches when a pool holds ONLY stale editions of a
   *  document. Just under the top: the point is REPRESENTATION (so
   *  edition steering can demote the stale siblings and diversity keeps
   *  the current overview), not free ranking. */
  editionCoverDiscount: 0.9,
  /** Overview-chunk demotion — overview chunks repeat title/doctype
   *  boilerplate and embed strongly for name-like queries, crowding
   *  clause chunks out of the rerank window. */
  overviewDemotion: 0.85,
  /** Glossary-link cosine floor — below this the dense match to a
   *  defined term is noise, not a candidate. Calibrated on the
   *  drifting→durability probe (durability-def 0.542, noise ~0.3). */
  glossaryCosineFloor: 0.5,
  /** Exact-term nudge (spread multiplier) — clause chunks whose head IS
   *  the asked-for term get a decisive nudge because publication headers
   *  contain the title words and the reranker alone is unreliable there;
   *  >1 so it dominates the spread, unlike the additive steering boosts. */
  termNudgeSpread: 1.5,
  /** Concept-steering rerank boost (spread fraction) — the vocabulary
   *  link's defining families get the edition-steering boost idiom.
   *  0.15 is enough to lift in-family content past the cross-encoder's
   *  vocabulary bias without overriding genuine relevance. */
  conceptSteerSpread: 0.15,
  /** Cross-publication recency boost (spread fraction) — a
   *  current-edition publication ranks over stale ones; composed with
   *  the family-relative demotion below. */
  crossPubRecencySpread: 0.1,
  /** Family-relative edition demotion (spread fraction) — superseded
   *  editions are demoted when a newer edition of the same publication
   *  is in the pool; a sibling one revision back still competes. */
  familyDemoteSpread: 0.4,
  /** Relevance-floored window — passages below this fraction of the
   *  top rerank score leave the window (the evidence-budget principle;
   *  structural units are exempt). */
  windowFloorFraction: 0.25,
  /** Small-to-big parent fetch discount — the parent clause enters at
   *  a discount because it's supplementary grounding, not the answer. */
  smallToBigDiscount: 0.7,
  /** Section-descent child discount — children fetched from a ranked
   *  depth-1 summary enter discounted. */
  sectionDescentDiscount: 0.8,
  /** History budget share — the fraction of the context budget the
   *  conversation slice may consume; older turns overflow into the
   *  compacted summary instead of starving the passages. */
  historyBudgetShare: 0.3,
} as const;

/** Process-expansion — appended to process-intent queries; publisher
 *  vocabulary from the profile (read at request time — see profile.ts). */
export function processExpansion(): string {
  return P().retrieval.process_expansion;
}

/** Per-deployment model override: <ROLE>_MODEL (e.g. UNDERSTAND_MODEL)
 *  replaces the pinned default for that role. Ops lever for A/B-ing a
 *  role's model without a code change; absent/invalid = the default. */
export function roleModel(env: any, role: keyof typeof MODELS): string {
  const ov = env[`${role.toUpperCase()}_MODEL`];
  return typeof ov === "string" && ov.startsWith("@cf/") ? ov : MODELS[role];
}

const EFFORTS = new Set(["low", "medium", "high", "max"]);

/** Per-deployment effort override for the answer lane (ANSWER_EFFORT).
 *  The effort–accuracy curve is front-loaded (DeepSeek-V4.1-Flash report,
 *  Fig. 9): serving pins "low" for latency, and any move up must be
 *  measured on the golden set — this lever makes that measurable live,
 *  same pattern as roleModel. Absent/invalid = "low". */
export function answerEffort(env: any): string {
  const v = env?.ANSWER_EFFORT;
  return typeof v === "string" && EFFORTS.has(v) ? v : "low";
}

/** Per-request effort for the answer lane (the user-facing depth toggle).
 *  The vocabulary is validated; elevated efforts (medium+) are a member
 *  lane — same cost rule as research — and degrade to the deployment
 *  lever for anonymous or silent requests. */
/** Elevated effort reasons longer — the output budget must grow with it
 *  or reasoning starves the content (the GLM-5 rule; measured
 *  2026-09-12: medium at the flat 3072 budget scored 5/38 on the golden
 *  set — empty answers — versus 37–38/38 at low). */
export function effortBudget(effort: string): number {
  if (effort === "medium") return LIMITS.maxOutputTokens * 2;
  if (effort === "high" || effort === "max") return LIMITS.maxOutputTokens * 4;
  return LIMITS.maxOutputTokens;
}

export function requestEffort(env: any, session: unknown, requested: unknown): string {
  if (typeof requested !== "string" || !EFFORTS.has(requested)) return answerEffort(env);
  if (requested === "low") return requested;
  return session ? requested : answerEffort(env);
}

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

// The catalog is publisher data (profile/datasets.yaml, codegen into
// profile.gen.ts) — the engine ships no publisher facts
export function DATASETS(): readonly Dataset[] {
  return P().datasets;
}

/** The estate permission gate: a session-gated dataset requires BOTH
 *  membership and the named permission (a role code the account carries
 *  in id.oimlsmart.org). Enforcement is server-side — the UI's lock is
 *  cosmetic; /api/ask federation and the scope intersect here too. */
export function hasPermission(session: unknown, code: string): boolean {
  const roles = (session as { roles?: unknown } | null)?.roles;
  return Array.isArray(roles) && roles.map(String).includes(code);
}

export function datasetAllowed(d: Dataset, session: unknown): boolean {
  if (!d.session) return true;
  if (!session) return false;
  return hasPermission(session, d.permission ?? "ai-preview");
}

export function datasetsFor(session: unknown): unknown[] {
  return DATASETS().map((d) => ({
    id: d.id,
    label: d.label,
    description: d.description,
    enabled: datasetAllowed(d, session),
    ...(d.session
      ? { requires: `the ${d.permission ?? "ai-preview"} permission (${P().publisher.identity.issuer.replace(/^https?:\/\//, "")})`, authenticated: !!session }
      : {}),
  }));
}

/** Empty-state starter questions, served by /api/datasets — UI content
 *  comes from the API, never hardcoded in the client. */
export function SUGGESTIONS(): string[] {
  return [...P().ui.suggestions];
}

/** The first-run starters as the publisher structures them: one question
 *  per capability, labelled, so the interface's first presentation of
 *  the service shows what it can do rather than a flat cloud of
 *  definition lookups. Falls back to the flat list when the profile
 *  declares none. */
export function STARTERS(): { label: string; q: string }[] {
  const groups = (P().ui as { starter_groups?: { label: string; q: string }[] }).starter_groups;
  return Array.isArray(groups) && groups.length ? groups.map((g) => ({ label: g.label, q: g.q })) : SUGGESTIONS().map((q) => ({ label: "", q }));
}

export function num(env: Record<string, unknown>, key: string, fallback: number): number {
  const v = Number(env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
