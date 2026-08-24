export const MODELS = {
  embed: "@cf/qwen/qwen3-embedding-0.6b",
  rerank: "@cf/baai/bge-reranker-base",
  anon: "@cf/qwen/qwen3-30b-a3b-fp8",
  member: "@cf/qwen/qwen3.8-27b", // Standard QA tier for signed-in members
} as const;

export const LIMITS = {
  maxInputChars: 1200,
  maxOutputTokens: 3072, // qwen3-30b-a3b always reasons; 768 starved the answer entirely
  retrieveK: 50, // Vectorize caps topK at 50 when returnMetadata=all
  rerankKeep: 8,
  cacheTtlSec: 6 * 3600,
} as const;

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
