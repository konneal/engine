/** VectorIndex — dense search with metadata filters. The port contract
 *  IS the wire law: metadata values are scalars or string arrays
 *  (API error 40017 otherwise); getByIds returns empty above its
 *  batch cap, so adapters chunk. Lexical search stays ENGINE-side —
 *  adapters need only dense+filters, the weakest common denominator. */
export interface VectorMatch {
  id: string;
  score: number;
  metadata: Record<string, unknown> | null;
}
export interface VectorQuery {
  vector: number[];
  topK: number;
  filter?: Record<string, unknown>;
}
export interface VectorUpsert {
  id: string;
  values: number[];
  metadata: Record<string, unknown>;
}

export interface VectorIndex {
  query(q: VectorQuery): Promise<VectorMatch[]>;
  upsert(vectors: VectorUpsert[]): Promise<void>;
  getByIds(ids: string[]): Promise<VectorMatch[]>;
}
