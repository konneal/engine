// The worker's binding surface (typed once, imported everywhere).
/** The Workers AI binding — run() only. Domain code goes through
 *  portModelRunner(env); a precisely-typed AI closes the door on passing
 *  the raw binding where a ModelRunner is expected (the v2.107 outage). */
export interface AiBinding {
  run(model: string, body: unknown): Promise<unknown>;
}

export interface Env {
  AI: AiBinding;
  VECTORIZE: any;
  EXP_PRIMMEL: any;
  EXP_COMPOSED: any;
  EXP_PLAIN: any;
  EXP_ADC: any;
  EXP_MKO: any;
  EXP_PFLAT: any;
  GLOSSARY: any;
  EXP_DB: D1Database;
  CACHE: KVNamespace;
  DB: D1Database;
  ASSETS: Fetcher;
  INDEX_VERSION: string;
  UNIT_ASSETS: R2Bucket;
  ANON_DAY_ASK: string;
  ANON_DAY_SEARCH: string;
  KEY_DAY_ASK_DEFAULT: string;
  ANON_DAY_HARD_CAP: string;
  ADMIN_TOKEN?: string;
  MEMBER_DAY_ASK?: string;
  ENRICH_MODEL?: string;
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_REDIRECT_URI?: string;
  SESSION_SECRET?: string;
  /** TODO.ai-platform/03 — the "my account" live-data delegation: the
   *  platform instance's API base + its client id at the OP (the
   *  delegation's scope target). Absent = the account chip honestly
   *  reports the live read unwired on this deployment. */
  SMART_PLATFORM_API?: string;
  SMART_PLATFORM_CLIENT_ID?: string;
  INTERNAL_SERVICE?: { fetch(input: RequestInfo, init?: RequestInit): Promise<Response> };
}

// ── The port view of the deployment (konneal extraction §5) ──────────
// Compose the port interfaces over the raw bindings ONCE, at the edges.
// Domain modules import `portModelRunner(env)` etc. — never env.AI
// directly; the purity lint enforces it. Zero runtime change: the
// adapters forward to the same bindings the call sites used before.
import { cfModelRunner, cfVectorIndex, cfKv, cfBlobs, cfRuntime, cfStore } from "./ports/cloudflare/adapters.ts";
import type { ModelRunner } from "./ports/model.ts";
import type { VectorIndex } from "./ports/vector.ts";
import type { Kv } from "./ports/kv.ts";
import type { Blobs } from "./ports/blobs.ts";
import type { Runtime } from "./ports/runtime.ts";
import type { StoreQuery } from "./ports/store.ts";

export function portModelRunner(env: Env): ModelRunner {
  return cfModelRunner(env.AI);
}
export function portIndex(env: Env, which: "public" | "primmel" | "composed" | "plain" | "adoc" | "mko" | "pflat" | "glossary" = "public"): VectorIndex {
  const b: unknown =
    which === "public" ? env.VECTORIZE
    : which === "primmel" ? env.EXP_PRIMMEL
    : which === "composed" ? env.EXP_COMPOSED
    : which === "plain" ? env.EXP_PLAIN
    : which === "adoc" ? env.EXP_ADC
    : which === "mko" ? env.EXP_MKO
    : which === "pflat" ? env.EXP_PFLAT
    : env.GLOSSARY;
  return cfVectorIndex(b);
}
export function portKv(env: Env): Kv {
  return cfKv(env.CACHE);
}
export function portBlobs(env: Env): Blobs {
  return cfBlobs(env.UNIT_ASSETS);
}
export function portStore(env: Env): StoreQuery {
  return cfStore(env.DB);
}
/** Does the deployment bind this lane index? Presence wiring stays in
 *  the ports layer so domain stages never touch raw bindings. */
export function hasLane(env: Env, which: "glossary"): boolean {
  switch (which) {
    case "glossary":
      return !!env.GLOSSARY;
  }
}

export function portRuntime(ctx: ExecutionContext | undefined): Runtime {
  return cfRuntime(ctx);
}
