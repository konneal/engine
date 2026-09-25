// The draft tool (TODO.ai-platform/04) — the act-with-confirmation
// wave's service half. The assistant PREPARES an act; the user commits
// it in the platform's real UI. The invariants, and how this module
// keeps them:
//
//   - THE AI NEVER WRITES. The draft is composed HERE and rides the
//     answer's wire shape back to the panel, which hands it to the
//     platform's real form; the commit is the user's own click through
//     the platform's own write path (the same validation, the same
//     gates, the same audit). This module is STRUCTURALLY write-free:
//     it performs no network IO at all — the ask handler hands it the
//     already-exchanged delegation token (livedata.ts's RFC 8693
//     machinery, read-scoped), the documents registry (D1) and the
//     Workers-AI binding; there is no fetch in this file. A crafted
//     prompt ("submit it now with my token") therefore cannot produce a
//     write — at most a draft that names the user's own click as the
//     only commit. The platform's bearer cone (oimlsmart/smart's
//     auth/bearer.ts) refuses the delegated write class outright either
//     way; the golden suite's draft-must-not legs prove the end-to-end.
//
//   - THE PREFILL NEVER INVENTS. The extraction (an LLM pass over the
//     conversation) PROPOSES fields; the traceability guard DISPOSES:
//     every drafted value must trace — through its own source span — to
//     the user's own messages, or it is dropped and the answer names
//     the drop. The values the instrument MODEL derives never ride the
//     draft at all: the platform's form derives them on open (the same
//     derivation layer as every prefill), the user confirms each one.
//
//   - THE REFUSAL SPEAKS THE PLATFORM'S VOCABULARY. The act's
//     permission reads the exchanged token's service_roles — the same
//     roles the platform enforces, re-judged live at the exchange. A
//     role that cannot perform the act gets the honest why (and no
//     draft), never a silent widening.
//
// The pilot act is the application prefill. The act vocabulary is the
// seam's contract (rag docs/API.md §drafts): the TL dispatch, the
// review comment and the evaluation summary are named follow-ups the
// same machinery extends to.

// ── the wire shapes (the estate contract — the panel and the platform
//    mirror them; rag docs/API.md is the reference) ───────────────────

export interface DraftSample {
  serial: string;
  condition?: string;
}

export interface ApplicationPrefillFields {
  /** the Recommendation, as the estate URN (urn:oiml:pub:r:60:2021) */
  standard_doc: string;
  /** display label ("ACME AB 99:2019") */
  standard_label?: string;
  family_designation?: string;
  group_label?: string;
  model_designation?: string;
  description?: string;
  samples?: DraftSample[];
  scheme?: "A" | "B";
}

export interface DraftDrop {
  field: string;
  value: string;
  reason: string;
}

export interface DraftAct {
  kind: "draft";
  act: "application_prefill";
  version: 1;
  title: string;
  prepared_at: string;
  /** ALWAYS true — the draft is an input to the real form, never a
   *  channel; the user's own click is the only commit. */
  requires_confirmation: true;
  fields: ApplicationPrefillFields;
  dropped?: DraftDrop[];
  notes?: string[];
}

export interface DraftCitation {
  docidentifier: string;
  edition?: string;
  status?: string;
}

export type DraftRefusalReason =
  | "sign_in_required"
  | "not_configured"
  | "window_expired"
  | "exchange_refused"
  | "role_refused"
  | "standard_unresolved"
  | "extraction_failed";

export type DraftVerdict =
  | { status: "draft"; draft: DraftAct; answer: string; citation: DraftCitation | null }
  | { status: "refused"; reason: DraftRefusalReason; answer: string; citation: DraftCitation | null };

/** The delegation outcome the ask handler computed (livedata.ts's
 *  exchange; this module never performs it). */
export type DraftDelegation =
  | { status: "ok"; token: string }
  | { status: "unsigned" | "not_configured" | "window_expired" | "refused" | "op_unreachable" };

export interface PrepareOpts {
  act: "application_prefill";
  query: string;
  history: Array<{ role: string; content: string }>;
  member: { sub: string } | null;
  delegation: DraftDelegation;
  /** the platform's client id at the OP (the service_roles key) */
  platformClientId?: string;
  /** the extraction model (the cheap understand lane) */
  model: string;
}

// ── the intent detection ─────────────────────────────────────────────
// Conservative by design: a false negative simply answers as knowledge
// (the corpus path handles "how do I apply"); a false positive would
// offer an act the user never asked for. The act verbs bind the
// application target in either order; "submit/file" map to the DRAFT
// act too — the answer honestly reframes them (the service never
// performs).

const ACT_VERB = "(?:draft|prepare|pre-?fill|fill\\s+(?:in|out)|start|submit|file|lodge)";
const ACT_TARGET = "(?:new\\s+)?(?:certification\\s+|type[ -]evaluation\\s+)?application";
const INTENT_RES = [
  new RegExp(`\\b${ACT_VERB}\\b[\\s\\S]{0,60}?\\b${ACT_TARGET}\\b`, "i"),
  new RegExp(`\\b${ACT_TARGET}\\b[\\s\\S]{0,30}?\\b(?:draft|prepare|pre-?fill|for me)\\b`, "i"),
];

/** The draft intent, or null. "What documents does an application
 *  need?" and "where is my application?" never trigger — no act verb. */
export function detectDraftIntent(query: string): "application_prefill" | null {
  // a STATUS read of an existing application is a question, not an act
  if (/\b(?:status|where|progress|state)\b/i.test(query) && /\bapplication\b/i.test(query) && !INTENT_RES[0].test(query)) return null;
  return INTENT_RES.some((re) => re.test(query)) ? "application_prefill" : null;
}

// ── the platform's role vocabulary (the refusal speaks it) ───────────

/** Decode the exchanged token's roles for the platform (the service's
 *  OWN fetched token — decoded, never re-validated; livedata.ts's
 *  roleFamilyOf posture). */
function decodeServiceRoles(token: string, platformClientId: string): string[] {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    const roles = payload?.service_roles?.[platformClientId];
    return Array.isArray(roles) ? roles.filter((r: unknown): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

/** The plain-language label for the account's primary role — the
 *  refusal names what the account IS, in the platform's own vocabulary. */
function roleLabel(role: string): string {
  if (role === "tl_operator") return "a test laboratory operator";
  if (["ia_officer", "case_officer", "certification_officer", "signatory"].includes(role)) return "an issuing authority officer";
  if (role === "viewer") return "a read-only viewer";
  if (["cs_admin", "admin"].includes(role)) return "a scheme administrator";
  return `the "${role}" role`;
}

// ── the extraction (the LLM proposes) ────────────────────────────────

const EXTRACTION_SYSTEM = `You extract the fields of a new certification application from the user's own messages.

Rules:
- Output ONLY a JSON object — no prose, no code fence.
- Copy every value from the user's own words, and for each field give "source": the exact contiguous span of the user's message you copied it from.
- NEVER infer, complete, normalize away, or guess a value. If the user did not state it, omit the field entirely.
- "standard": the publication the user named (e.g. "AB 99" or "ACME AB 99:2019") — a plain string, or omit when none was named.
- "scheme": only when the user named scheme A or scheme B explicitly.

Schema (every field optional):
{
  "standard": "AB 99",
  "family_designation": { "value": "…", "source": "…" },
  "group_label": { "value": "…", "source": "…" },
  "model_designation": { "value": "…", "source": "…" },
  "description": { "value": "…", "source": "…" },
  "scheme": { "value": "A", "source": "…" },
  "samples": [ { "serial": "…", "condition": "…", "source": "…" } ]
}`;

interface Extraction {
  standard?: string;
  family_designation?: { value?: string; source?: string };
  group_label?: { value?: string; source?: string };
  model_designation?: { value?: string; source?: string };
  description?: { value?: string; source?: string };
  scheme?: { value?: string; source?: string };
  samples?: Array<{ serial?: string; condition?: string; source?: string }>;
}

/** The extraction pass: the LLM reads the user's turns and PROPOSES the
 *  fields, each with the source span it was copied from. The guard
 *  disposes — a proposal the user never stated never rides the draft. */
async function extractDraftFields(ai: any, model: string, userTurns: string[]): Promise<Extraction | null> {
  const transcript = userTurns.map((t, i) => `${i + 1}. ${t}`).join("\n").slice(0, 12000);
  try {
    const res: any = await ai.run(model, {
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM },
        { role: "user", content: `The user's messages, oldest first:\n${transcript}` },
      ],
      max_tokens: 1200,
      reasoning_effort: "low",
      temperature: 0.1,
    });
    const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
    if (typeof text !== "string") return null;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? (parsed as Extraction) : null;
  } catch {
    return null;
  }
}

// ── the traceability guard (the never-invents must-not) ──────────────

/** The guard's normalization: case/punctuation-insensitive, hyphen kept
 *  (the serials and designations carry it). */
const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9-]+/g, " ").replace(/\s+/g, " ").trim();
/** The document-name normalization: whitespace-free ("R 60" ≡ "R60"). */
const docNorm = (s: string) => norm(s).replace(/\s+/g, "");

/** The traceability primitive, shared with the api_call act's body guard
 *  (apicalls.ts): a value traces when it appears in the user's own
 *  messages (normalized). The proposing model never gets the benefit of
 *  the doubt — the user's words are the only source. */
export function valueTracesToUser(value: unknown, userTurns: string[]): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const haystack = norm(userTurns.join("\n"));
  return haystack.includes(norm(value));
}

export interface GuardedFields {
  standard?: string;
  family_designation?: string;
  group_label?: string;
  model_designation?: string;
  description?: string;
  scheme?: "A" | "B";
  samples?: DraftSample[];
}

const DROP_REASON = "not stated in your own words";

/**
 * THE GUARD: a proposed field rides the draft only when its source span
 * appears in the user's own messages AND the value appears in the span —
 * the proposal must be the user's words, never the model's completion.
 * Every rejection is a named drop (the answer accounts for each). */
export function traceabilityGuard(extraction: Extraction, userTurns: string[]): { kept: GuardedFields; dropped: DraftDrop[] } {
  const haystack = norm(userTurns.join("\n"));
  const docHaystack = docNorm(userTurns.join(" "));
  const kept: GuardedFields = {};
  const dropped: DraftDrop[] = [];

  const traced = (value: unknown, source: unknown): string | null => {
    if (typeof value !== "string" || !value.trim()) return null;
    if (typeof source !== "string" || !source.trim()) return null;
    const v = norm(value);
    const s = norm(source);
    if (!v || !s) return null;
    return s.includes(v) && haystack.includes(s) ? value.trim() : null;
  };

  const scalar = (field: "family_designation" | "group_label" | "model_designation" | "description") => {
    const entry = extraction[field];
    const ok = entry ? traced(entry.value, entry.source) : null;
    if (ok) kept[field] = ok.slice(0, 300);
    else if (entry && typeof entry.value === "string" && entry.value.trim()) {
      dropped.push({ field, value: entry.value.trim().slice(0, 120), reason: DROP_REASON });
    }
  };
  scalar("family_designation");
  scalar("group_label");
  scalar("model_designation");
  scalar("description");

  const scheme = extraction.scheme;
  const schemeOk = scheme ? traced(scheme.value, scheme.source) : null;
  if (schemeOk && /^[ab]$/i.test(schemeOk.trim())) kept.scheme = schemeOk.trim().toUpperCase() as "A" | "B";
  else if (scheme && typeof scheme.value === "string" && scheme.value.trim()) {
    dropped.push({ field: "scheme", value: scheme.value.trim().slice(0, 20), reason: DROP_REASON });
  }

  const samples: DraftSample[] = [];
  (Array.isArray(extraction.samples) ? extraction.samples : []).forEach((s, i) => {
    const ok = s ? traced(s.serial, s.source) : null;
    if (ok) {
      const sample: DraftSample = { serial: ok.slice(0, 80) };
      if (typeof s?.condition === "string" && s.condition.trim()) sample.condition = s.condition.trim().slice(0, 20).toUpperCase();
      samples.push(sample);
    } else if (s && typeof s.serial === "string" && s.serial.trim()) {
      dropped.push({ field: `samples[${i}].serial`, value: s.serial.trim().slice(0, 80), reason: DROP_REASON });
    }
  });
  if (samples.length) kept.samples = samples;

  // The act's anchor: the Recommendation the USER named (whitespace-free
  // matching — "R 60" ≡ "R60" ≡ "r 60"). Untraced = the user never chose
  // it; the compose refuses honestly below.
  if (typeof extraction.standard === "string" && extraction.standard.trim()) {
    if (docHaystack.includes(docNorm(extraction.standard))) kept.standard = extraction.standard.trim().slice(0, 80);
    else dropped.push({ field: "standard", value: extraction.standard.trim().slice(0, 80), reason: DROP_REASON });
  }

  return { kept, dropped };
}

// ── the standard resolution (the corpus registry anchors the act) ────

interface ResolvedStandard {
  urn: string;
  label: string;
  edition?: string;
  status?: string;
}

/** Resolve the named Recommendation against the documents registry: the
 *  family must exist (the ACTIVE edition is the draft's anchor), else
 *  the draft honestly has nothing to anchor on. */
async function resolveStandard(env: any, named: string): Promise<ResolvedStandard | null> {
  const m =
    named.match(/^urn:oiml:pub:([rdbge]):(\d{1,3})(?:-[0-9A-Za-z]+)?(?::(\d{4}))?$/i) ??
    named.match(/^(?:OIML\s+)?([RDBGE])\s*(\d{1,3})(?:-[0-9A-Za-z]+)?(?:\s*:\s*(\d{4}))?$/i);
  if (!m) return null;
  const type = m[1].toUpperCase();
  const num = String(Number(m[2]));
  try {
    const row = (await env.DB.prepare(
      "SELECT docidentifier, edition, status, derived_status FROM documents WHERE family = ?1 AND active = 1 ORDER BY (part IS NULL) DESC, edition DESC LIMIT 1",
    ).bind(`${type}-${num}`).first()) as any;
    if (!row) return null;
    const edition = typeof row.edition === "string" ? row.edition : undefined;
    return {
      urn: `urn:oiml:pub:${type.toLowerCase()}:${num}${edition ? `:${edition}` : ""}`,
      label: typeof row.docidentifier === "string" ? row.docidentifier : `OIML ${type} ${num}`,
      ...(edition ? { edition } : {}),
      status: typeof row.derived_status === "string" ? row.derived_status : typeof row.status === "string" ? row.status : undefined,
    };
  } catch {
    // a registry read failure proceeds honestly as unresolved — a scoped
    // refusal is more honest than a guessed anchor (context.ts's posture)
    return null;
  }
}

// ── the composition (deterministic — the answer text is never an
//    invention channel either) ────────────────────────────────────────

const FIELD_LABELS: Array<[keyof GuardedFields, string]> = [
  ["family_designation", "the instrument family"],
  ["group_label", "the instrument group"],
  ["model_designation", "the model designation"],
  ["description", "the description"],
];

function refusal(reason: DraftRefusalReason, answer: string): DraftVerdict {
  return { status: "refused", reason, answer, citation: null };
}

/** The draft act's full path: the member gate → the delegation's honest
 *  states → the role permission (the platform's vocabulary) → the
 *  extraction → the guard → the registry anchor → the draft. */
export async function prepareDraft(env: any, opts: PrepareOpts): Promise<DraftVerdict> {
  if (!opts.member || opts.delegation.status === "unsigned") {
    return refusal(
      "sign_in_required",
      "Preparing an act starts from your own account — sign in with your OIML SMART account and ask again. " +
        "The draft would still be yours alone: it opens in the real form and only your own click commits it — I never hold a write credential.",
    );
  }
  if (opts.delegation.status === "not_configured") {
    return refusal(
      "not_configured",
      "This deployment has not wired the live account link, so I cannot prepare acts here. " +
        "I can still explain what the application asks for — just ask.",
    );
  }
  if (opts.delegation.status === "window_expired") {
    return refusal(
      "window_expired",
      "Your live access window has lapsed — sign in again to refresh it, and I will prepare the draft. " +
        "It stays a draft either way: only your own click in the real form commits it.",
    );
  }
  if (opts.delegation.status !== "ok") {
    return refusal(
      "exchange_refused",
      "The live role check was refused, so I cannot prepare the draft honestly — the act needs your account's standing. " +
        "Sign in afresh and ask again.",
    );
  }

  // The permission, in the platform's own vocabulary: the pilot act is
  // the applicant's self-served entry. The exchanged token's roles were
  // re-judged live at the exchange — a standing lost mid-session narrows
  // here, exactly as the platform narrows.
  const roles = opts.platformClientId ? decodeServiceRoles(opts.delegation.token, opts.platformClientId) : [];
  if (!roles.includes("applicant")) {
    const primary = roles[0] ?? "unknown";
    return refusal(
      "role_refused",
      `Your account's platform role — ${roleLabel(primary)} — can't prepare a new certification application: ` +
        "that act belongs to the applicant (the manufacturer's own account). Nothing was drafted. " +
        "I can still walk you through what the application asks for — just ask.",
    );
  }

  // The user turns are the ONLY source a field may come from.
  const userTurns = [
    ...opts.history.filter((h) => h.role === "user").map((h) => h.content),
    opts.query,
  ];
  const extraction = await extractDraftFields(env.AI, opts.model, userTurns);
  if (!extraction) {
    return refusal(
      "extraction_failed",
      "I could not read your requirements reliably just now — nothing was drafted. Ask again in a moment, " +
        "or start the application directly in the portal: every field there is yours either way.",
    );
  }
  const { kept, dropped } = traceabilityGuard(extraction, userTurns);

  if (!kept.standard) {
    const untraced = dropped.find((d) => d.field === "standard");
    return refusal(
      "standard_unresolved",
      untraced
        ? `I can't anchor the draft: you haven't named the Recommendation in your own words (the ${untraced.value} reading isn't yours). ` +
          "Name it plainly — for example ACME AB 99 — and I'll prepare the draft."
        : "I can't anchor the draft: you haven't named the publication. Name it plainly — for example ACME AB 99 — and I'll prepare it.",
    );
  }
  const standard = await resolveStandard(env, kept.standard);
  if (!standard) {
    return refusal(
      "standard_unresolved",
      `I couldn't resolve ${kept.standard} as a publication in the corpus, so I can't anchor the draft. ` +
        "Name the publication plainly — for example ACME AB 99 — and I'll prepare it.",
    );
  }

  const fields: ApplicationPrefillFields = {
    standard_doc: standard.urn,
    standard_label: standard.label,
    ...(kept.family_designation ? { family_designation: kept.family_designation } : {}),
    ...(kept.group_label ? { group_label: kept.group_label } : {}),
    ...(kept.model_designation ? { model_designation: kept.model_designation } : {}),
    ...(kept.description ? { description: kept.description } : {}),
    ...(kept.samples?.length ? { samples: kept.samples } : {}),
    ...(kept.scheme ? { scheme: kept.scheme } : {}),
  };

  const carries: string[] = [`the Recommendation: ${standard.label}`];
  for (const [key, label] of FIELD_LABELS) {
    const v = kept[key];
    if (typeof v === "string") carries.push(`${label}: ${v}`);
  }
  if (kept.scheme) carries.push(`scheme ${kept.scheme}`);
  if (kept.samples?.length) carries.push(`${kept.samples.length} sample${kept.samples.length === 1 ? "" : "s"}: ${kept.samples.map((s) => s.serial).join(", ")}`);

  const notes = [
    `The technical parameters (capacities, dimensions, classes) stay with you: the form derives what ${standard.label}'s model declares, and you confirm each value.`,
    "Every field in the real form stays editable — the draft is a starting point, never a decision.",
  ];

  const draft: DraftAct = {
    kind: "draft",
    act: "application_prefill",
    version: 1,
    title: `New ${standard.label} application`,
    prepared_at: new Date().toISOString(),
    requires_confirmation: true,
    fields,
    ...(dropped.length ? { dropped } : {}),
    notes,
  };

  const answer =
    `I've prepared a draft for a new ${standard.label} application from your own words.\n\n` +
    `What the draft carries:\n${carries.map((c) => `- ${c}`).join("\n")}\n` +
    (dropped.length
      ? `\nI left ${dropped.length === 1 ? "this" : "these"} out because you never stated ${dropped.length === 1 ? "it" : "them"} in your own words: ` +
        `${dropped.map((d) => `${d.field.replace(/\[(\d+)\]/, " $1")} ("${d.value}")`).join("; ")}. Say them plainly and I'll add them.\n`
      : "") +
    `\n${notes[0]}\n\n` +
    "The draft opens in the real application form with every field editable — review it carefully. " +
    "Nothing is submitted until you confirm it there yourself: I never hold a write credential; your own click is the only commit.";

  return {
    status: "draft",
    draft,
    answer,
    citation: { docidentifier: standard.label, ...(standard.edition ? { edition: standard.edition } : {}), ...(standard.status ? { status: standard.status } : {}) },
  };
}
