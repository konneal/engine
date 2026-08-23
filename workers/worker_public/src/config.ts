export const MODELS = {
  embed: "@cf/qwen/qwen3-embedding-0.6b",
  rerank: "@cf/baai/bge-reranker-base",
  anon: "@cf/qwen/qwen3-30b-a3b-fp8",
} as const;

export const LIMITS = {
  maxInputChars: 1200,
  maxOutputTokens: 768,
  retrieveK: 20,
  rerankKeep: 5,
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
