// The api_call draft act (TODO.ai-platform/09) — the operations
// assistant's proposal grammar. One platform operation, prepared as a
// draft; the panel pre-flights it against the platform's assembled
// specification (unknown method+path pairs refuse there), the act class
// decides the arc (preference rides the standing grant's seam; record
// confirms per act and executes as the user), and the platform's own
// gates judge the write. This module, like drafts.ts, is STRUCTURALLY
// write-free: it reads the operation directory (D1) and calls the
// pick model; there is no fetch to the platform here.
//
// The invariants, and how this module keeps them:
//
//   - THE DIRECTORY IS THE CLOSED WORLD. A draft's call names an
//     operation the deployment's operation directory (the D1 `api_ops`
//     table, loaded from the publisher's OpenAPI plane at ingest)
//     actually carries — resolved by operation id AFTER the model
//     proposes. An id the directory does not hold is no draft, ever;
//     the model cannot invent a path because it never writes one.
//
//   - THE MACHINE FACET BOUNDS THE MACHINE ACTS. An entity-context ask
//     whose machine facet offers acts may propose only from that set
//     (machineOffers); an empty set is the honest "the user can read
//     but not act" — the answer says so and no draft rides. The facet
//     is advisory; the platform re-judges authoritatively.
//
//   - THE NEVER-OFFER LIST IS PROFILE DATA. The publisher declares the
//     operations the assistant never proposes (the auth family — signout
//     is the user's own, forever — and the grant's own mint/revoke:
//     delegation is granted by the user's hand on the settings page,
//     never by a chat message). The list filters the pick prompt AND
//     re-checks the picked operation (belt and braces).
//
//   - BODIES TRACE. A preference draft's body carries only values the
//     user stated (drafts.ts's traceability primitive); an untraceable
//     body refuses honestly instead of guessing settings.
//
//   - TITLES SAY WHAT THE ACT DOES. "Save the filter", never
//     "Execute PUT /api/…" — a title that leaks the wire shape is
//     rejected and falls back to the operation's own summary.

import { P } from "./profile.ts";
import { machineOffers, type DeclaredContext, type MachineContext } from "./context.ts";
import { valueTracesToUser } from "./drafts.ts";
import { portModelRunner, portStore } from "./env.ts";
import type { ModelRunner } from "./ports/model.ts";
import type { StoreQuery } from "./ports/store.ts";

// ── the wire shape (the estate contract — the panel and the platform
//    mirror it; the deployment's docs carry the reference) ────────────

export interface ApiCall {
  method: "POST" | "PUT" | "PATCH" | "DELETE" | "GET";
  path: string;
  body?: unknown;
}

export interface ApiCallDraft {
  kind: "draft";
  act: "api_call";
  version: 1;
  title: string;
  prepared_at: string;
  /** ALWAYS true — the card's tap (or the standing grant, for the
   *  preference family) is the only authority that executes. */
  requires_confirmation: true;
  call: ApiCall;
  notes?: string[];
}

export type ApiCallRefusalReason =
  | "sign_in_required"
  | "machine_read_only"
  | "no_matching_act"
  | "entity_unresolved"
  | "operation_unknown"
  | "operation_never_offered"
  | "body_untraced"
  | "pick_failed";

export type ApiCallVerdict =
  | { status: "draft"; draft: ApiCallDraft; answer: string }
  | { status: "refused"; reason: ApiCallRefusalReason; answer: string };

// ── the profile's acts facet (publisher data — the engine ships none) ─

interface ActsProfile {
  /** the generic entity write the machine acts ride (path carries the
   *  {store}/{id} template exactly as the plane declares it) */
  entity_write?: { method: string; path: string };
  /** the entity pages' route patterns → the store the entity lives in */
  entity_routes?: Array<{ pattern: string; store: string }>;
  /** path prefixes the assistant never proposes (the auth family, the
   *  grant's own mint/revoke) */
  never_offer?: string[];
}

function actsProfile(): ActsProfile | null {
  const acts = (P() as any).publisher?.acts;
  return acts && typeof acts === "object" ? acts : null;
}

/** A target the assistant never proposes: the never-offer prefixes match
 *  the operation's declared (templated) path. */
export function neverOffered(path: string): boolean {
  const prefixes = actsProfile()?.never_offer ?? [];
  return prefixes.some((p) => typeof p === "string" && path.startsWith(p));
}

// ── the operation directory (D1, loaded from the plane at ingest) ────

export interface ApiOp {
  operation_id: string;
  method: string;
  path: string;
  act_class: string | null;
  summary: string | null;
  tag: string | null;
}

async function operationById(store: StoreQuery, id: string): Promise<ApiOp | null> {
  try {
    return (await store.prepare("SELECT operation_id, method, path, act_class, summary, tag FROM api_ops WHERE operation_id = ?1").bind(id).first()) as ApiOp | null;
  } catch {
    return null;
  }
}

async function operationByMethodPath(store: StoreQuery, method: string, path: string): Promise<ApiOp | null> {
  try {
    return (await store.prepare("SELECT operation_id, method, path, act_class, summary, tag FROM api_ops WHERE method = ?1 AND path = ?2").bind(method.toLowerCase(), path).first()) as ApiOp | null;
  } catch {
    return null;
  }
}

/** The preference family (the standing grant's closed world), for the
 *  pick prompt — bounded; a deployment whose family outgrows the cap
 *  truncates honestly (the directory read is ordered, never random). */
async function preferenceOps(store: StoreQuery): Promise<ApiOp[]> {
  try {
    const rows = await store.prepare("SELECT operation_id, method, path, act_class, summary, tag FROM api_ops WHERE act_class = 'preference' ORDER BY operation_id LIMIT 32").bind().all();
    return ((rows as any).results ?? []) as ApiOp[];
  } catch {
    return [];
  }
}

// ── the entity resolution (the route pattern table is profile data) ──

/** Parse the declared context's route against the profile's entity-route
 *  patterns (`/a/b/:id` segments; the LAST parameter captures the entity
 *  id). Returns the store + id the entity write addresses, or null — a
 *  route the table does not cover is an honest unresolved, never a guess. */
export function resolveEntityRoute(route: string | undefined): { store: string; id: string } | null {
  const patterns = actsProfile()?.entity_routes ?? [];
  if (!route) return null;
  const segs = route.split("?")[0]!.split("/").filter(Boolean);
  for (const p of patterns) {
    const psegs = String(p.pattern ?? "").split("/").filter(Boolean);
    if (psegs.length !== segs.length) continue;
    let id: string | null = null;
    let ok = true;
    for (let i = 0; i < psegs.length; i++) {
      const ps = psegs[i]!;
      if (ps.startsWith(":")) {
        id = decodeURIComponent(segs[i]!);
      } else if (ps !== segs[i]) {
        ok = false;
        break;
      }
    }
    // the id is a routing token, bounded and charset-checked — it lands
    // in a URL path, never in prose
    if (ok && id && id.length <= 120 && /^[A-Za-z0-9._~-]+$/.test(id)) return { store: String(p.store), id };
  }
  return null;
}

// ── the intent detection (conservative — a false positive would offer
//    an act the user never asked for) ─────────────────────────────────

/** The machine-act intent: an entity declaration with a machine facet,
 *  plus the user's own act verb aimed at the entity. */
const MACHINE_INTENT_RE =
  /\b(accept|reject|submit|resubmit|withdraw|suspend|reinstate|renew|revise|transfer|issue|register|log|record|dispatch|complete|sign|approve|verify)\b[\s\S]{0,40}\b(this|that|the|it)\b|\b(this|that|the|it)\b[\s\S]{0,40}\b(accept|reject|submit|resubmit|withdraw|suspend|reinstate|renew|revise|transfer|issue|register|log|dispatch|complete|sign|approve|verify)\b/i;

/** The preference intent: the user's own settings vocabulary. */
const PREFERENCE_INTENT_RE =
  /\b(mute|unmute|unsubscribe|subscribe|notification prefs?|notification rules?|email prefs?|email preferences|saved? filters?|save (?:this|the|that) filter|notify me|stop notifying|inbox)\b/i;

export type ApiCallIntent = "machine_act" | "preference";

/** A question ABOUT a concept is never an act request ("What is a saved
 *  filter?" asks for knowledge; "save this filter" acts). Conservative
 *  by design: the question openers steer to the corpus path. */
const QUESTION_OPENER_RE = /^\s*(?:what|how|why|where|when|which|who|whose|explain|describe|define|is|are|does|do)\b/i;

/** Which api_call family the ask aims at, or null. The machine facet
 *  decides the machine family (no facet = no machine act, whatever the
 *  verbs); the preference family needs no facet. */
export function detectApiCallIntent(query: string, declared: DeclaredContext | null): ApiCallIntent | null {
  if (QUESTION_OPENER_RE.test(query)) return null;
  if (declared?.kind === "entity" && declared.machine && MACHINE_INTENT_RE.test(query)) return "machine_act";
  if (PREFERENCE_INTENT_RE.test(query)) return "preference";
  return null;
}

// ── the pick (the model proposes; the directory and the facet dispose) ─

interface Pick {
  /** machine family: the offered action id; preference family: the
   *  operation id — null is the honest "nothing here matches" */
  target: string | null;
  title?: string;
  body?: unknown;
}

function pickPrompt(kind: ApiCallIntent, candidates: string[]): { system: string; max: number } {
  if (kind === "machine_act") {
    return {
      system: `You map the user's request to one machine act from the OFFERED list, or to none.

Rules:
- Output ONLY a JSON object — no prose, no code fence: {"target": "<action id or null>", "title": "<what the act does, plain words>"}.
- The target must be one of the offered action ids, copied exactly, or null when the request matches none.
- The title names what the act DOES for the user ("Accept the application"), never the wire (no method, no path, no "/api/").
- Never invent an act that is not listed.

Offered acts (action id — lands the entity on):
${candidates.join("\n")}`,
      max: 300,
    };
  }
  return {
    system: `You map the user's request to one operation from the PREFERENCE list (the user's own settings), or to none.

Rules:
- Output ONLY a JSON object — no prose, no code fence: {"target": "<operation id or null>", "title": "<what the act does, plain words>", "body": {...}}.
- The target must be one of the listed operation ids, copied exactly, or null when the request matches none.
- "body" carries only values the user stated in their own words; omit it when the request names no values.
- The title names what the act DOES for the user ("Save the filter", "Mute these emails"), never the wire (no method, no path, no "/api/").
- Never invent an operation that is not listed.

Preference operations (id — method path — summary):
${candidates.join("\n")}`,
    max: 800,
  };
}

async function pickTarget(runner: ModelRunner, model: string, kind: ApiCallIntent, candidates: string[], userTurns: string[]): Promise<Pick | null> {
  const { system, max } = pickPrompt(kind, candidates);
  const transcript = userTurns.map((t, i) => `${i + 1}. ${t}`).join("\n").slice(0, 8000);
  try {
    const res = await runner.run({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `The user's messages, oldest first:\n${transcript}` },
      ],
      maxTokens: max,
      effort: "low",
      temperature: 0.1,
    });
    const text = res.text;
    if (typeof text !== "string") return null;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object") return null;
    return {
      target: typeof parsed.target === "string" && parsed.target.trim() ? parsed.target.trim().slice(0, 120) : null,
      title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim().slice(0, 120) : undefined,
      body: parsed.body && typeof parsed.body === "object" ? parsed.body : undefined,
    };
  } catch {
    return null;
  }
}

/** The title guard: a title that leaks the wire shape is no title. */
function honestTitle(proposed: string | undefined, fallback: string): string {
  const t = (proposed ?? "").trim();
  if (!t) return fallback;
  if (/\b(GET|POST|PUT|PATCH|DELETE)\b/.test(t) || t.includes("/api/") || t.includes("{")) return fallback;
  return t.slice(0, 120);
}

/** The body guard: every string value traces to the user's own words
 *  (the never-invents doctrine, drafts.ts's primitive). Scalars the user
 *  toggles (booleans, numbers) pass — they state no fact. */
export function bodyTraces(body: unknown, userTurns: string[]): boolean {
  if (body == null) return true;
  if (typeof body === "boolean" || typeof body === "number") return true;
  if (typeof body === "string") return valueTracesToUser(body, userTurns);
  if (Array.isArray(body)) return body.every((v) => bodyTraces(v, userTurns));
  if (typeof body === "object") return Object.values(body as Record<string, unknown>).every((v) => bodyTraces(v, userTurns));
  return false;
}

// ── the composition ──────────────────────────────────────────────────

export interface ApiCallPrepareOpts {
  intent: ApiCallIntent;
  query: string;
  history: Array<{ role: string; content: string }>;
  member: { sub: string } | null;
  declared: DeclaredContext | null;
  /** the intent-mapping model (the profile's pick — the operations
   *  deployment runs the stronger reasoning tier here) */
  model: string;
}

function refusal(reason: ApiCallRefusalReason, answer: string): ApiCallVerdict {
  return { status: "refused", reason, answer };
}

export async function prepareApiCall(env: any, opts: ApiCallPrepareOpts): Promise<ApiCallVerdict> {
  if (!opts.member) {
    return refusal(
      "sign_in_required",
      "Preparing an act starts from your own account — sign in and ask again. " +
        "The draft would still be yours alone: the card asks for your confirmation, and only your own tap executes it — I never hold a write credential.",
    );
  }
  const acts = actsProfile();
  const store = portStore(env);
  const runner = portModelRunner(env);
  const userTurns = [...opts.history.filter((h) => h.role === "user").map((h) => h.content), opts.query];

  // ── the machine family: the offered set bounds the proposal ──
  if (opts.intent === "machine_act") {
    const machine = opts.declared?.machine as MachineContext | undefined;
    const label = opts.declared?.label || "this record";
    if (!machine) {
      return refusal("no_matching_act", "This page did not declare the record's lifecycle state, so I cannot propose an act on it honestly. Open the record itself and ask again, or act from the platform's own controls — they always show exactly what your role may do.");
    }
    if (machine.acts.length === 0) {
      // the honest "read but not act": say so, propose nothing
      return refusal(
        "machine_read_only",
        `The record's lifecycle is at ${machine.state}, and the machine offers your role no acts there — you can read this record but not act on it. ` +
          "Nothing was drafted. If that looks wrong, an officer of your organization can check the role your account carries.",
      );
    }
    const entity = resolveEntityRoute(opts.declared?.route);
    if (!entity) {
      return refusal("entity_unresolved", "I cannot tell which record the act would land on from this page, so nothing was drafted. The platform's own controls on the record always act on the right one.");
    }
    const candidates = machine.acts.map((a) => `${a.action} — lands on ${a.to}${a.guard ? ` (requires ${a.guard})` : ""}`);
    const pick = await pickTarget(runner, opts.model, "machine_act", candidates, userTurns);
    if (!pick) {
      return refusal("pick_failed", "I could not map your request to an act reliably just now — nothing was drafted. Ask again in a moment, or act from the platform's own controls.");
    }
    if (!pick.target || !machineOffers(machine, pick.target)) {
      const offered = machine.acts.map((a) => a.action).join(", ");
      return refusal(
        "no_matching_act",
        `None of the acts the machine offers your role at ${machine.state} matches that request — the offered set is exactly: ${offered}. ` +
          "I never propose an act outside it. Nothing was drafted.",
      );
    }
    const act = machine.acts.find((a) => a.action === pick.target)!;
    const write = acts?.entity_write;
    if (!write?.method || !write?.path) {
      return refusal("operation_unknown", "This deployment has not wired the entity write operation, so I cannot prepare the act here.");
    }
    // the directory is the closed world: the entity write must exist in
    // the plane, and the never-offer list re-checks even it
    const op = await operationByMethodPath(store, write.method, write.path);
    if (!op) {
      return refusal("operation_unknown", "The act's operation is not in this deployment's API directory, so I cannot prepare it honestly — nothing was drafted.");
    }
    if (neverOffered(op.path)) {
      return refusal("operation_never_offered", "That act is not one the assistant may propose — nothing was drafted.");
    }
    const path = write.path.replace("{store}", entity.store).replace("{id}", entity.id);
    const title = honestTitle(pick.title, `${act.action} — ${label}`.slice(0, 120));
    const notes = [
      `The machine act ${act.action} moves the record from ${machine.state} to ${act.to}; the platform re-judges the act against the machine and your role when you confirm.`,
      ...(act.guard ? [`This act declares the ${act.guard} input — the confirmation card collects it; the draft carries none.`] : []),
    ];
    const draft: ApiCallDraft = {
      kind: "draft",
      act: "api_call",
      version: 1,
      title,
      prepared_at: new Date().toISOString(),
      requires_confirmation: true,
      call: { method: write.method as ApiCall["method"], path, body: { status: act.to } },
      notes,
    };
    const answer =
      `I've prepared the act "${title}" for ${label}: the machine act ${act.action}, from ${machine.state} to ${act.to}.\n\n` +
      `The confirmation card carries it — a record act, so your own confirmation signs it and the platform's gates judge the write as you. ` +
      `I never hold a write credential, and I never propose an act the machine does not offer your role.`;
    return { status: "draft", draft, answer };
  }

  // ── the preference family: the standing grant's closed world ──
  const family = (await preferenceOps(store)).filter((o) => !neverOffered(o.path));
  if (!family.length) {
    return refusal("operation_unknown", "This deployment's API directory lists no preference operations, so I cannot prepare that here — nothing was drafted.");
  }
  const candidates = family.map((o) => `${o.operation_id} — ${o.method.toUpperCase()} ${o.path} — ${o.summary ?? ""}`.slice(0, 300));
  const pick = await pickTarget(runner, opts.model, "preference", candidates, userTurns);
  if (!pick) {
    return refusal("pick_failed", "I could not map your request to a preference act reliably just now — nothing was drafted. Ask again in a moment, or change the setting on your account page directly.");
  }
  if (!pick.target) {
    return refusal("no_matching_act", "None of the preference acts I may propose matches that request — nothing was drafted. Your account's settings page carries the full set.");
  }
  const op = await operationById(store, pick.target);
  if (!op || op.act_class !== "preference") {
    // the picked id resolves to nothing, or to a record act — either way
    // the draft never rides (the model proposed outside the closed world)
    return refusal("operation_unknown", "I cannot match that request to a preference act the platform declares — nothing was drafted.");
  }
  if (neverOffered(op.path)) {
    return refusal("operation_never_offered", "That act is not one the assistant may propose — delegation and sign-in acts stay in your own hands on the settings page. Nothing was drafted.");
  }
  if (pick.body !== undefined && !bodyTraces(pick.body, userTurns)) {
    return refusal(
      "body_untraced",
      "I can't prepare that change because the values I would set are not ones you stated — I never invent settings. " +
        "Tell me exactly what to set, in your own words, and I'll prepare the draft.",
    );
  }
  const title = honestTitle(pick.title, (op.summary ?? op.operation_id).slice(0, 120));
  const draft: ApiCallDraft = {
    kind: "draft",
    act: "api_call",
    version: 1,
    title,
    prepared_at: new Date().toISOString(),
    requires_confirmation: true,
    call: { method: op.method.toUpperCase() as ApiCall["method"], path: op.path, ...(pick.body !== undefined ? { body: pick.body } : {}) },
    notes: [
      "A preference act: with your standing grant the card executes it straight away; without one, your own tap on the card confirms it. The grant is yours on the settings page — granted or revoked by your hand, never by a message.",
    ],
  };
  const answer =
    `I've prepared the act "${title}" — a preference act on your own settings.\n\n` +
    "With your standing grant it executes under the grant's authority; without one, the card asks once and your tap confirms it. " +
    "The platform re-checks the act against its own specification either way, and the grant never covers record acts.";
  return { status: "draft", draft, answer };
}
