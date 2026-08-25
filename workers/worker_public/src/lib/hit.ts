// Shared Hit construction (DRY: previously duplicated ×5 in pipeline).
import type { Hit, ChunkMeta } from "../pipeline";

export function toHit(m: any): Hit {
  return {
    id: m.id,
    score: m.score,
    metadata: (m.metadata ?? {}) as ChunkMeta,
    text: (m.metadata?.chunk_text as string) ?? "",
  };
}

export function toHits(matches: any[]): Hit[] {
  return (matches ?? []).map(toHit);
}
