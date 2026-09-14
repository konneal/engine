import type { Env } from "./env";
/** Contextual enrichment (quality-first lane): for each chunk, write a
 *  situating context (KV-cached per chunk id), embed context+text, and
 *  upsert in place — the enrichment persists into every future retrieval
 *  of that chunk. Driven by ingest/enrich.py in resumable batches. */
export declare function handleEnrich(env: Env, ctx: ExecutionContext, req: Request): Promise<Response>;
/** Section-summary units (FABLE/BEAR multi-granularity, arXiv:2601.18116):
 *  the corpus's clause chunks start at depth 2 ("3.1"), so the tree has no
 *  depth-1 nodes. This endpoint writes them: a summary of each top-level
 *  clause generated from its child chunks' excerpts (quality-first lane,
 *  KV-cached per unit id), embedded as toc-path ⊕ summary à la FABLE's
 *  internal-node indexing, and upserted as a navigation node — serving
 *  descends from it to quotable leaf clauses (pipeline.ts section
 *  descent). Credential, batching and ledger mirror /admin/enrich. */
export declare function handleSectionUnit(env: Env, ctx: ExecutionContext, req: Request): Promise<Response>;
/** Ops access to the Vectorize binding (get/upsert by id) for offline
 *  passes like embedding smoothing (G-ETSI-4) — the binding is the
 *  credential, admin-token gated exactly like /admin/enrich. */
/** One-time figure captioning (TODO.remaining/03): fetch the unit's asset
 *  from R2, describe it with the vision-capable answer model, store the
 *  description into unit_payloads. Admin-gated; idempotent. */
export declare function handleCaption(env: Env, req: Request): Promise<Response>;
export declare function handleVectors(env: Env, req: Request): Promise<Response>;
export declare function handleJudge(env: Env, req: Request): Promise<Response>;
export declare function handleCreateKey(env: Env, req: Request): Promise<Response>;
export declare function handleListKeys(env: Env, req: Request): Promise<Response>;
/** Revoke an API key (soft: revoked = 1 — the hash row stays for
 *  audit; authenticate() already excludes revoked keys). */
export declare function handleRevokeKey(env: Env, req: Request, id: string): Promise<Response>;
