export const MODELS = {
  embed: "@cf/qwen/qwen3-embedding-0.6b",
  rerank: "@cf/baai/bge-reranker-base",
  anon: "@cf/qwen/qwen3-30b-a3b-fp8",
  member: "@cf/qwen/qwen3.8-27b", // Standard QA tier for signed-in members
  grader: "@cf/deepseek-ai/deepseek-v4-flash", // CRAG retrieval grader (cached input is near-free)
} as const;

export const LIMITS = {
  maxInputChars: 1200,
  maxOutputTokens: 3072, // qwen3-30b-a3b always reasons; 768 starved the answer entirely
  retrieveK: 50, // Vectorize caps topK at 50 when returnMetadata=all
  rerankKeep: 8,
  cacheTtlSec: 6 * 3600,
  // context-window budget (estimated tokens) for the assembled prompt —
  // system + history slice + passages must fit or the model request fails
  inputTokenBudget: 12000,
  maxPassageTokens: 900, // per-passage cap (clause chunks with tables can be huge)
} as const;

/** The corpus catalog — single source for /api/datasets and for the
 *  assistant's self-description. `session: true` datasets are enabled
 *  for signed-in members (federated via the internal service binding). */
export const DATASETS: { id: string; label: string; description: string; session?: boolean }[] = [
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
