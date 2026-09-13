/** ModelRunner — the port over every model call. Adapters translate
 *  into provider catalogs and own provider-specific call shaping:
 *  request-shape probing (rerank variants), sampling quirks, the
 *  effort-budget coupling. Domain modules never see a provider body.
 *
 *  multi-SDO / multi-cloud: docs/konneal-extraction-plan.md §5. */
export interface GenerateRequest {
  model: string;
  messages: unknown[];
  effort?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stream?: boolean;
}
export interface GenerateResult {
  text: string | null;
  stream?: ReadableStream<Uint8Array> | null;
}

export interface ModelRunner {
  embed(texts: string[]): Promise<number[][]>;
  /** rerank with adapter-side request-shape probing; returns one score
   *  per text, or null when the provider degraded (caller falls back) */
  rerank(model: string, query: string, texts: string[]): Promise<number[] | null>;
  run(req: GenerateRequest): Promise<GenerateResult>;
}
