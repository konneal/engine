/** Runtime — background work after the response. The semantic is
 *  fire-and-forget best effort: adapters may await or schedule; the
 *  domain must never depend on completion for correctness. */
export interface Runtime {
  defer(fn: () => Promise<void>): void;
}

/** Background — the raw waitUntil surface. ExecutionContext satisfies
 *  this structurally; telemetry and other edge utilities depend on the
 *  shape, never on the provider type. */
export interface Background {
  waitUntil(p: Promise<unknown>): void;
}
