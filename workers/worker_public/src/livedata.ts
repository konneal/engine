// The live-data tool (TODO.ai-platform/03) — the "my account" context's
// service half. The user opted the message into their OWN live platform
// data; the service reads the platform EXACTLY as the user, never wider:
//
//   1. The sign-in (auth.ts) retains the OP's access token for the
//      SESSION's window only (KV, keyed by the session token's hash,
//      TTL = the OP token's own expiry — never D1, never past it).
//   2. The exchange (the identity service's RFC 8693 session delegation,
//      RP guide §9b) trades that subject token for a narrowly-scoped OP
//      JWT: `<platform>:read`, the account's standing RE-JUDGED at the
//      exchange (a role lost mid-session narrows the next answer
//      honestly), the actor claim naming THIS service.
//   3. The platform reads ride that JWT; the platform enforces the cones
//      exactly as for the user's own browser (smart's bearer cone). THE
//      MUST-NOT IS STRUCTURAL HERE: this module maps the platform's
//      answers 1:1 into records — it cannot invent a row the platform
//      did not return, and a store the cone refuses simply contributes
//      nothing.
//
// The exchanged JWT is cached for its own short life (KV, TTL-bounded)
// so an ask burst costs one exchange; nothing outlives the session's
// exchange window.

/** SHA-256 hex — config.ts's helper, inlined so this module stays
 *  dependency-free (context.ts's pattern: the unit tests load it on
 *  plain node's type stripping, which never resolves extensionless
 *  relative imports). */
import { P } from "./profile.ts";
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── configuration ────────────────────────────────────────────────────

export interface LiveDataConfig {
  /** The platform instance's API base (the hub's origin). */
  platformApi: string;
  /** The platform's client id at the OP (the delegation's scope target
   *  + the exchanged token's audience). */
  platformClientId: string;
  /** The OP's issuer (the exchange endpoint lives there). */
  issuer: string;
  /** THIS service's client credentials (the delegation's caller auth —
   *  the subject token binds to the client it was issued to). */
  clientId: string;
  clientSecret?: string;
}

export function liveDataConfig(env: any): LiveDataConfig | null {
  const platformApi = (env.SMART_PLATFORM_API ?? "").trim().replace(/\/$/, "");
  const platformClientId = (env.SMART_PLATFORM_CLIENT_ID ?? "").trim();
  const issuer = (env.OIDC_ISSUER ?? "").trim().replace(/\/$/, "");
  const clientId = (env.OIDC_CLIENT_ID ?? "").trim();
  if (!platformApi || !platformClientId || !clientId || !issuer) return null;
  return { platformApi, platformClientId, issuer, clientId, clientSecret: env.OIDC_CLIENT_SECRET };
}

// ── the session's exchange window (the retained OP access token) ─────

const SUBJECT_KEY = (sessionHash: string) => `opat:${sessionHash}`;
const EXCHANGED_KEY = (sessionHash: string) => `ossx:${sessionHash}`;

/** Retain the sign-in's OP access token for the session's exchange
 *  window (the OP token's own TTL, minus a small margin). Called ONCE
 *  per sign-in from the auth callback; the token never persists past
 *  the window. */
// The session's refresh-token store (oidc-refresh.ts): the OP's refresh
// grant is what makes session renewal a RE-JUDGMENT of live standing
// instead of a re-stamp of frozen claims. Same KV discipline as the
// access token: keyed by the session token's hash, TTL = the grant's
// own life, never D1.
const REFRESH_KEY = (sessionHash: string) => `ort:${sessionHash}`;
const REFRESH_TTL_SEC = 30 * 24 * 60 * 60; // the OP's grant TTL default

export async function retainRefreshToken(env: any, sessionRaw: string, refreshToken: string): Promise<void> {
  try {
    await env.CACHE.put(REFRESH_KEY(await sha256Hex(sessionRaw)), JSON.stringify({ token: refreshToken }), {
      expirationTtl: REFRESH_TTL_SEC,
    });
  } catch {
    // a KV hiccup degrades to the legacy staleness, never blocks sign-in
  }
}

export async function readRefreshToken(env: any, sessionRaw: string): Promise<string | null> {
  try {
    const hit = await env.CACHE.get(REFRESH_KEY(await sha256Hex(sessionRaw)), "json");
    return typeof hit?.token === "string" ? hit.token : null;
  } catch {
    return null;
  }
}

export async function dropRefreshToken(env: any, sessionRaw: string): Promise<void> {
  try {
    await env.CACHE.delete(REFRESH_KEY(await sha256Hex(sessionRaw)));
  } catch {
    // best effort
  }
}

export async function retainOpAccessToken(
  env: any,
  sessionRaw: string,
  opAccessToken: string,
  expiresInSec: number,
): Promise<void> {
  const ttl = Math.max(30, Math.floor(expiresInSec) - 30);
  try {
    await env.CACHE.put(SUBJECT_KEY(await sha256Hex(sessionRaw)), JSON.stringify({ token: opAccessToken }), { expirationTtl: ttl });
  } catch {
    // a KV hiccup degrades the live window honestly (the chip answers
    // "live data unavailable"), never blocks the sign-in
  }
}

/** Drop the retained subject + the cached exchanged token (the sign-out
 *  closes the window deliberately, never by expiry alone). */
export async function dropOpAccessToken(env: any, sessionRaw: string): Promise<void> {
  const h = await sha256Hex(sessionRaw);
  try {
    await env.CACHE.delete(SUBJECT_KEY(h));
    await env.CACHE.delete(EXCHANGED_KEY(h));
  } catch {
    /* the TTL closes the window regardless */
  }
}

// ── the RFC 8693 delegation exchange ─────────────────────────────────

export type LiveTokenVerdict =
  | { ok: true; token: string }
  | { ok: false; reason: "not_configured" | "window_expired" | "refused" | "op_unreachable" };

/** Exchange the session's retained OP access token for the
 *  platform-scoped JWT (identity's §9b). The exchanged token caches for
 *  its own short life; the refusal lattice is honest per leg. */
export async function exchangeForLiveToken(env: any, sessionRaw: string): Promise<LiveTokenVerdict> {
  const cfg = liveDataConfig(env);
  if (!cfg) return { ok: false, reason: "not_configured" };
  const h = await sha256Hex(sessionRaw);

  const cached = await env.CACHE.get(EXCHANGED_KEY(h));
  if (cached) return { ok: true, token: cached };

  const subjectRow = await env.CACHE.get(SUBJECT_KEY(h), "json") as { token?: string } | null;
  if (!subjectRow?.token) return { ok: false, reason: "window_expired" };

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    subject_token: subjectRow.token,
    scope: `${cfg.platformClientId}:read`,
  });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (cfg.clientSecret) {
    headers.authorization = `Basic ${btoa(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`)}`;
  } else {
    body.set("client_id", cfg.clientId);
  }
  let res: Response;
  try {
    res = await fetch(`${cfg.issuer}/op/token`, { method: "POST", headers, body });
  } catch {
    return { ok: false, reason: "op_unreachable" };
  }
  if (!res.ok) {
    // The refusal's code is logged, NEVER the subject token: a refused
    // exchange narrows the answer honestly (the window lapsed, the
    // standing fell away, or the deployment refuses).
    const code = await res.json().then((j: any) => j?.error ?? "unknown").catch(() => "unknown");
    console.log("live-data exchange refused:", res.status, code);
    return { ok: false, reason: code === "invalid_grant" ? "window_expired" : "refused" };
  }
  const granted = (await res.json()) as { access_token?: string; expires_in?: number; scope?: string };
  if (!granted.access_token) return { ok: false, reason: "refused" };
  // The exchange's own answer states the granted scope — read it, never
  // assume it (the standing re-judgment may have narrowed honestly).
  const ttl = Math.max(30, Math.floor(granted.expires_in ?? 300) - 60);
  try {
    await env.CACHE.put(EXCHANGED_KEY(h), granted.access_token, { expirationTtl: ttl });
  } catch {
    /* the exchange simply re-runs next ask */
  }
  return { ok: true, token: granted.access_token };
}

/** The live read token for one ask (TODO.ai-platform/12 — the session
 *  bridge): when the member arrived on the delegated bearer, the Bearer
 *  IS already the OP-minted platform-scoped JWT — the platform exchanged
 *  it before forwarding, so a second exchange here would have no subject
 *  token to ride (the bubble never signed into THIS service). If the
 *  token's scope cone covers the platform read, present it directly;
 *  otherwise (a service session, or a delegation that never scoped the
 *  platform in) fall through to the RFC 8693 exchange. */
export async function liveTokenFor(
  env: any,
  sessionRaw: string,
  member: { via?: string; scope?: string } | null,
): Promise<LiveTokenVerdict> {
  const cfg = liveDataConfig(env);
  if (!cfg) return { ok: false, reason: "not_configured" };
  if (member?.via === "delegated" && typeof member.scope === "string") {
    const need = `${cfg.platformClientId}:read`;
    if (member.scope.split(/\s+/).includes(need)) return { ok: true, token: sessionRaw };
  }
  return exchangeForLiveToken(env, sessionRaw);
}

// ── the platform reads (the records the answer grounds in) ───────────

export interface LiveRecord {
  /** the platform store the record came from */
  store: string;
  id: string;
  /** the display label ("Application APP-2026-001 — R 60") */
  label: string;
  /** the platform page the record links to */
  url: string;
  status?: string;
  date?: string;
  /** the coarse one-line state ("evaluation in progress", "3 test
   *  requests dispatched") — the progress projection's summary */
  detail?: string;
}

export type LiveRead =
  | { ok: true; records: LiveRecord[]; stores: string[]; readAt: string }
  | { ok: false; reason: "platform_refused" | "platform_unreachable" };

/** The platform page for a record — the role family decides the console
 *  (the same page the user's own browser would open). */
function recordUrl(cfg: LiveDataConfig, roleFamily: string, store: string, row: any): string {
  const std = typeof row.standard_id === "string" ? row.standard_id.replace(new RegExp(`^${P().publisher.id}-`, "i"), "") : null;
  if (store === "certificates") {
    if (roleFamily === "applicant") return `${cfg.platformApi}/app/portal/certificates/${row.id}`;
    if (std) return `${cfg.platformApi}/app/standards/${std}/certificates/${row.id}`;
    return `${cfg.platformApi}/app/portal/certificates/${row.id}`;
  }
  // applications + testRequests resolve to their application page (the
  // request is visible within its project on every console).
  const appId = store === "applications" ? row.id : (row.application_id ?? row.id);
  if (roleFamily === "ia") return `${cfg.platformApi}/app/ia/applications/${appId}`;
  if (roleFamily === "lab") return `${cfg.platformApi}/app/lab/projects/${appId}`;
  return `${cfg.platformApi}/app/portal/applications/${appId}`;
}

/** The exchanged JWT's primary platform role (the service's OWN fetched
 *  token — decoded, never re-validated) decides the console family. */
function roleFamilyOf(token: string, platformClientId: string): string {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    const roles: string[] = payload?.service_roles?.[platformClientId] ?? [];
    const primary = roles[0] ?? "";
    if (["ia_officer", "case_officer", "certification_officer", "signatory"].includes(primary)) return "ia";
    if (primary === "tl_operator") return "lab";
    return "applicant";
  } catch {
    return "applicant";
  }
}

const MAX_RECORDS = 12;
const PROGRESS_FOR = 3;

/** Read the account's live surface: the bounded store lists (the cone
 *  filters server-side — a refused store contributes NOTHING, never an
 *  error into the answer) + the progress projection for the freshest
 *  applications. Every record maps 1:1 from a platform row. */
export async function readMyAccount(_env: any, cfg: LiveDataConfig, token: string): Promise<LiveRead> {
  const auth = { authorization: `Bearer ${token}` };
  const readAt = new Date().toISOString();
  const family = roleFamilyOf(token, cfg.platformClientId);
  const records: LiveRecord[] = [];
  const storesRead: string[] = [];

  async function readStore(store: string): Promise<any[]> {
    let res: Response;
    try {
      res = await fetch(`${cfg.platformApi}/api/entities/${store}`, { headers: auth });
    } catch {
      throw new Error("unreachable");
    }
    if (!res.ok) {
      // The cone's honest refusal (403) or an unauthenticated read (401):
      // the store contributes nothing — the records stay exactly what the
      // account may see.
      console.log(`live-data: ${store} answered ${res.status} — skipped`);
      return [];
    }
    storesRead.push(store);
    const rows = (await res.json()) as any[];
    return Array.isArray(rows) ? rows : [];
  }

  let applications: any[] = [];
  try {
    applications = await readStore("applications");
    const certificates = await readStore("certificates");
    const requests = await readStore("testRequests");
    for (const row of applications) {
      records.push({
        store: "applications",
        id: String(row.id),
        label: `Application ${row.application_number ?? row.id}${row.standard_id ? ` — ${String(row.standard_id).replace(new RegExp(`^${P().publisher.id}-`, "i"), "").toUpperCase().replace(/^R(\d)/, "R $1")}` : ""}`,
        url: recordUrl(cfg, family, "applications", row),
        status: row.status,
        date: row.submitted_date ?? row.date_of_application,
      });
    }
    for (const row of certificates) {
      records.push({
        store: "certificates",
        id: String(row.id),
        label: `Certificate ${row.certificate_number ?? row.id}`,
        url: recordUrl(cfg, family, "certificates", row),
        status: row.status,
        date: row.issue_date ?? row.registered_copy_of?.registered_date,
      });
    }
    for (const row of requests) {
      records.push({
        store: "testRequests",
        id: String(row.id),
        label: `Test request ${row.request_number ?? row.id}`,
        url: recordUrl(cfg, family, "testRequests", row),
        status: row.status,
        date: row.issued_date,
      });
    }
  } catch {
    return { ok: false, reason: "platform_unreachable" };
  }

  // The progress projection for the freshest applications (the "where is
  // my application" answer's own surface — the same coarse projection the
  // portal renders, never the work-in-flight stores).
  const freshest = applications
    .slice()
    .sort((a, b) => String(b.submitted_date ?? b.date_of_application ?? "").localeCompare(String(a.submitted_date ?? a.date_of_application ?? "")))
    .slice(0, PROGRESS_FOR);
  for (const row of freshest) {
    try {
      const res = await fetch(`${cfg.platformApi}/api/entities/applications/${encodeURIComponent(row.id)}/progress`, { headers: auth });
      if (!res.ok) continue;
      const p = (await res.json()) as any;
      const rec = records.find((r) => r.store === "applications" && r.id === String(row.id));
      if (rec) {
        const parts: string[] = [];
        if (p.evaluation?.state === "concluded") parts.push(`evaluation concluded${p.evaluation.decision ? ` (${p.evaluation.decision})` : ""}`);
        else if (p.evaluation?.state === "in_progress") parts.push("evaluation in progress");
        else parts.push("evaluation not started");
        if (Array.isArray(p.requests) && p.requests.length) parts.push(`${p.requests.length} test request${p.requests.length === 1 ? "" : "s"} dispatched`);
        if (p.certificate) parts.push(`certificate ${p.certificate.certificate_number ?? ""} ${p.certificate.status ?? ""}`.trim());
        rec.detail = parts.join("; ");
      }
    } catch {
      /* the projection is additive — the record stands without it */
    }
  }

  // The freshest surface first, bounded (the newest dates lead; a record
  // without a date sorts last).
  records.sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
  return { ok: true, records: records.slice(0, MAX_RECORDS), stores: storesRead, readAt };
}

// ── the ask path's composed resolution ───────────────────────────────

export type LiveAccount =
  | { status: "ok"; records: LiveRecord[]; stores: string[]; readAt: string }
  | { status: "unavailable"; reason: "sign_in_required" | "not_configured" | "window_expired" | "refused" | "op_unreachable" | "platform_refused" | "platform_unreachable" };

/** Resolve the "my account" context for one ask: the member's session →
 *  the exchange → the platform reads. Every failure is an honest reason
 *  the context line can state — never a silent widening, never an
 *  invented record. */
export async function resolveLiveAccount(
  env: any,
  sessionRaw: string | null,
  member: { sub: string; via?: string; scope?: string } | null,
): Promise<LiveAccount> {
  if (!member || !sessionRaw) return { status: "unavailable", reason: "sign_in_required" };
  const cfg = liveDataConfig(env);
  if (!cfg) return { status: "unavailable", reason: "not_configured" };
  const exchanged = await liveTokenFor(env, sessionRaw, member);
  if (!exchanged.ok) return { status: "unavailable", reason: exchanged.reason };
  const read = await readMyAccount(env, cfg, exchanged.token);
  if (!read.ok) return { status: "unavailable", reason: read.reason };
  return { status: "ok", records: read.records, stores: read.stores, readAt: read.readAt };
}
