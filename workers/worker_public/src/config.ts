export const MODELS = {
  embed: "@cf/qwen/qwen3-embedding-0.6b",
  rerank: "@cf/baai/bge-reranker-base",
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

/** The corpus catalog — single source for /api/datasets, the assistant's
 *  self-description, and per-corpus model guidance. `session: true`
 *  datasets are enabled for signed-in members (federated via the internal
 *  service binding). `note` (optional) is injected into the system prompt
 *  when passages from this corpus are present — corpus behavior travels
 *  with the dataset, not with pipeline code. */
export interface Dataset {
  id: string; // equals the chunk metadata `corpus` value
  label: string;
  description: string;
  session?: boolean;
  note?: string;
}

export const DATASETS: Dataset[] = [
  {
    id: "oiml",
    label: "OIML Publications",
    description: "Recommendations, Documents, Basic publications, Guides",
  },
  {
    id: "iso",
    label: "ISO/IEC Conformity Assessment",
    description: "ISO/IEC 17xxx standards — federated with OIML results for members",
    session: true,
    note: "Some passages come from the internal ISO/IEC corpus (labeled ISO/IEC …) — use them alongside the OIML passages and cite them the same way.",
  },
];

export function datasetsFor(session: unknown): unknown[] {
  return DATASETS.map((d) => ({
    id: d.id,
    label: d.label,
    description: d.description,
    enabled: !d.session || !!session,
    ...(d.session ? { requires: "an OIML SMART account", authenticated: !!session } : {}),
  }));
}

/** Empty-state starter questions, served by /api/datasets — UI content
 *  comes from the API, never hardcoded in the client. */
export const SUGGESTIONS: string[] = [
  "What is R 60?",
  "What is a load cell?",
  "What is the OIML-CS?",
  "Qu'est-ce que le OIML-CS ?",
];

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
