// The worker's binding surface (typed once, imported everywhere).
export interface Env {
  AI: any;
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
  EXEMPT_IPS?: string;
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
