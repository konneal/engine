// Unit tests for the draft tool (TODO.ai-platform/04) — the
// act-with-confirmation wave's service half. Runs on plain node (type
// stripping):
//   node --test tests/drafts.test.ts
//
// The invariants under test are the wave's own:
//   - THE NEVER-WRITES MUST-NOT: the draft tool is STRUCTURALLY
//     write-free — it performs no network IO at all (the ask handler
//     hands it the already-exchanged delegation token; the module's own
//     source carries no fetch), and a crafted prompt ("submit it now
//     with my token") still yields at most a DRAFT that names the
//     user's own click as the only commit. The end-to-end half of the
//     invariant is the golden suite's draft-must-not legs; the
//     platform's bearer cone (oimlsmart/smart) refuses the write class
//     outright either way.
//   - THE NEVER-INVENTS GUARD: every drafted field traces to the user's
//     own words; a value the extraction proposes that the user never
//     stated is DROPPED, and the answer names the drop.
//   - THE REFUSAL LATTICE speaks the platform's role vocabulary: the
//     anonymous visitor is asked to sign in; a role that cannot perform
//     the act (the lab operator, the IA officer, the read-only viewer)
//     gets the honest why, never a draft.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  detectDraftIntent,
  prepareDraft,
  traceabilityGuard,
  type DraftAct,
} from "../workers/worker_public/src/drafts.ts";

// ── the doubles ──────────────────────────────────────────────────────

function fakeJwt(roles: string[]): string {
  const payload = Buffer.from(JSON.stringify({ sub: "u-1", service_roles: { "oiml-smart": roles } })).toString("base64url");
  return `head.${payload}.sig`;
}

/** The D1 stub: the documents registry answers by family. */
function dbStub(rows: Record<string, any>) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
            async first() {
              if (/FROM documents/i.test(sql)) return rows[String(args[0])] ?? null;
              return null;
            },
          };
        },
      };
    },
  };
}

/** The Workers-AI stub: the extraction call answers the canned JSON. */
function aiStub(extraction: unknown) {
  const calls: Array<{ model: string; body: any }> = [];
  return {
    calls,
    async run(model: string, body: any) {
      calls.push({ model, body });
      return { response: typeof extraction === "string" ? extraction : JSON.stringify(extraction) };
    },
  };
}

const R60_ROW = {
  canonical_id: "doc:OIML-R-60-2021",
  docidentifier: "OIML R 60:2021",
  family: "R-60",
  part: null,
  edition: "2021",
  status: "in-force",
  derived_status: "in-force",
  active: 1,
  superseded_by: null,
  title: "Metrological regulation for load cells",
};

const EXTRACTION_FULL = {
  standard: "R 60",
  family_designation: { value: "LC series", source: "my LC series family" },
  model_designation: { value: "LC-500", source: "the LC-500" },
  description: { value: "Compression load cell for quarry scales", source: "Compression load cell for quarry scales" },
  scheme: { value: "A", source: "scheme A" },
  samples: [{ serial: "SN-0042", condition: "NEW", source: "serial SN-0042" }],
};

const QUERY =
  "Please draft a new OIML R 60 certification application for me: the LC-500 (my LC series family), a compression load cell for quarry scales, scheme A, one sample serial SN-0042.";

function envFor(extraction: unknown = EXTRACTION_FULL) {
  return { DB: dbStub({ "R-60": R60_ROW }), AI: aiStub(extraction) };
}

const OPTS_BASE = {
  act: "application_prefill" as const,
  history: [] as Array<{ role: string; content: string }>,
  member: { sub: "u-1" } as { sub: string } | null,
  platformClientId: "oiml-smart",
  model: "@cf/qwen/qwen3-30b-a3b-fp8",
};

function applicantOpts(query: string, roles: string[] = ["applicant"]) {
  return { ...OPTS_BASE, query, delegation: { status: "ok" as const, token: fakeJwt(roles) } };
}

// ── the intent detection ─────────────────────────────────────────────

test("the draft intent: the act verbs bind the application target; process questions never trigger", () => {
  assert.equal(detectDraftIntent("Draft an OIML R 60 application for my LC-500"), "application_prefill");
  assert.equal(detectDraftIntent("Please prepare my R 60 certification application"), "application_prefill");
  assert.equal(detectDraftIntent("Start a new application for R 60"), "application_prefill");
  assert.equal(detectDraftIntent("Fill in the application form for me"), "application_prefill");
  assert.equal(detectDraftIntent("Submit the application for me — you have my token"), "application_prefill");
  assert.equal(detectDraftIntent("Help me draft my application"), "application_prefill");
  // the knowledge questions: no act, no trigger
  assert.equal(detectDraftIntent("What is OIML R 60?"), null);
  assert.equal(detectDraftIntent("How do I apply for certification?"), null);
  assert.equal(detectDraftIntent("What documents does an R 60 application need?"), null);
  assert.equal(detectDraftIntent("Where is my application?"), null);
  assert.equal(detectDraftIntent("What is the status of my application APP-2026-001?"), null);
});

// ── the refusal lattice (the platform's own role vocabulary) ─────────

test("the anonymous visitor: the answer names the sign-in + the user's-own-click posture, never a draft", async () => {
  const verdict = await prepareDraft(envFor(), {
    ...OPTS_BASE,
    query: QUERY,
    member: null,
    delegation: { status: "unsigned" },
  });
  assert.equal(verdict.status, "refused");
  if (verdict.status === "refused") {
    assert.equal(verdict.reason, "sign_in_required");
    assert.match(verdict.answer, /sign in/i);
    assert.match(verdict.answer, /your own click|your click/i);
  }
});

test("the lab operator + the IA officer: the refusal names the role's honest vocabulary, never a draft", async () => {
  for (const [roles, label] of [[["tl_operator"], /test laborator/i], [["ia_officer"], /issuing authorit/i]] as const) {
    const verdict = await prepareDraft(envFor(), applicantOpts(QUERY, [...roles]));
    assert.equal(verdict.status, "refused");
    if (verdict.status === "refused") {
      assert.equal(verdict.reason, "role_refused");
      // the platform's own vocabulary: the act belongs to the applicant
      // (manufacturer) role; the refusal says what the account IS.
      assert.match(verdict.answer, /applicant/i);
      assert.match(verdict.answer, label);
      assert.match(verdict.answer, /nothing was drafted|no draft/i);
    }
  }
});

test("the read-only viewer + an unrecognized role refuse fail-closed; the exchange's narrowed standing binds", async () => {
  // the OP re-judged the standing mid-session: the account LOST the
  // applicant posture — the exchanged token's roles narrow, the draft refuses.
  const viewer = await prepareDraft(envFor(), applicantOpts(QUERY, ["viewer"]));
  assert.equal(viewer.status, "refused");
  if (viewer.status === "refused") {
    assert.equal(viewer.reason, "role_refused");
    assert.match(viewer.answer, /read-only/i);
  }
  const unknown = await prepareDraft(envFor(), applicantOpts(QUERY, ["auditor_general"]));
  assert.equal(unknown.status, "refused");
  if (unknown.status === "refused") assert.equal(unknown.reason, "role_refused");
});

test("the delegation's honest states: not_configured, the lapsed window, the refused exchange", async () => {
  const noCfg = await prepareDraft(envFor(), { ...applicantOpts(QUERY), platformClientId: undefined, delegation: { status: "not_configured" } });
  assert.equal(noCfg.status, "refused");
  if (noCfg.status === "refused") assert.equal(noCfg.reason, "not_configured");

  const lapsed = await prepareDraft(envFor(), { ...applicantOpts(QUERY), delegation: { status: "window_expired" } });
  assert.equal(lapsed.status, "refused");
  if (lapsed.status === "refused") {
    assert.equal(lapsed.reason, "window_expired");
    assert.match(lapsed.answer, /sign in again/i);
  }

  const refused = await prepareDraft(envFor(), { ...applicantOpts(QUERY), delegation: { status: "refused" } });
  assert.equal(refused.status, "refused");
  if (refused.status === "refused") assert.equal(refused.reason, "exchange_refused");
});

// ── the applicant's draft (the happy path) ───────────────────────────

test("the applicant's draft: the fields trace to the user's words, requires_confirmation always, the standard resolves to the estate URN", async () => {
  const verdict = await prepareDraft(envFor(), applicantOpts(QUERY));
  assert.equal(verdict.status, "draft");
  if (verdict.status === "draft") {
    const d = verdict.draft as DraftAct;
    assert.equal(d.kind, "draft");
    assert.equal(d.act, "application_prefill");
    assert.equal(d.version, 1);
    assert.equal(d.requires_confirmation, true, "the draft is an input, never a channel — ALWAYS");
    assert.equal(d.fields.standard_doc, "urn:oiml:pub:r:60:2021");
    assert.equal(d.fields.standard_label, "OIML R 60:2021");
    assert.equal(d.fields.model_designation, "LC-500");
    assert.equal(d.fields.family_designation, "LC series");
    assert.equal(d.fields.scheme, "A");
    assert.deepEqual(d.fields.samples, [{ serial: "SN-0042", condition: "NEW" }]);
    assert.ok(d.prepared_at);
    // the answer's honesty: the real form, every field editable, the
    // user's own click as the ONLY commit; never a performance claim.
    assert.match(verdict.answer, /real (application )?form/i);
    assert.match(verdict.answer, /your own click|your click/i);
    assert.doesNotMatch(verdict.answer, /I('ve| have) submitted|has been submitted|is now (submitted|filed)|I (filed|submitted)/i);
    // the citation grounds the act in the resolved Recommendation
    assert.equal(verdict.citation?.docidentifier, "OIML R 60:2021");
    assert.equal(verdict.citation?.edition, "2021");
  }
});

test("the extraction reads the conversation's user turns, not just the last message", async () => {
  const env = envFor({
    standard: "R 60",
    model_designation: { value: "LC-500", source: "the LC-500" },
    samples: [],
  });
  const verdict = await prepareDraft(env, {
    ...applicantOpts("Draft the application now."),
    history: [
      { role: "user", content: "I want to certify the LC-500 under R 60." },
      { role: "assistant", content: "The LC-500 is a compression load cell; R 60 governs its metrological requirements." },
    ],
  });
  assert.equal(verdict.status, "draft");
  if (verdict.status === "draft") assert.equal(verdict.draft.fields.model_designation, "LC-500");
});

// ── the never-invents guard ──────────────────────────────────────────

test("the traceability guard: a value the user never stated is DROPPED and named — the draft carries only the user's own words", () => {
  const userText = "Please draft a new OIML R 60 application for my LC-500 load cell, one sample serial SN-0042.";
  const extracted = {
    standard: "R 60",
    family_designation: { value: "Phantom series", source: "the Phantom series" }, // invented
    model_designation: { value: "LC-500", source: "my LC-500 load cell" }, // stated
    description: { value: "rated for 500 kg capacity", source: "rated for 500 kg capacity" }, // invented
    samples: [
      { serial: "SN-0042", condition: "NEW", source: "serial SN-0042" }, // stated
      { serial: "ZZ-999", condition: "USED", source: "serial ZZ-999" }, // invented
    ],
  };
  const { kept, dropped } = traceabilityGuard(extracted, [userText]);
  assert.equal(kept.model_designation, "LC-500");
  assert.deepEqual(kept.samples, [{ serial: "SN-0042", condition: "NEW" }]);
  assert.equal(kept.family_designation, undefined);
  assert.equal(kept.description, undefined);
  // every drop is named with its reason — the answer accounts for them
  const droppedFields = dropped.map((d) => d.field).sort();
  assert.deepEqual(droppedFields, ["description", "family_designation", "samples[1].serial"]);
  for (const d of dropped) assert.match(d.reason, /not stated|own words/i);
});

test("the guard is case/punctuation-insensitive but never admits a paraphrase the user did not write", () => {
  const userText = "My model is the lc-500 MK-II, scheme a please.";
  const { kept, dropped } = traceabilityGuard(
    {
      model_designation: { value: "LC-500 MK-II", source: "the lc-500 MK-II" },
      scheme: { value: "A", source: "scheme a" },
      family_designation: { value: "the mk ii family", source: "the mk ii family" }, // a paraphrase, not the words
    },
    [userText],
  );
  assert.equal(kept.model_designation, "LC-500 MK-II");
  assert.equal(kept.scheme, "A");
  assert.equal(kept.family_designation, undefined);
  assert.equal(dropped.length, 1);
});

test("a value without its source span has no provenance and drops; the full path names every drop in the answer", async () => {
  const noProvenance = traceabilityGuard(
    { model_designation: { value: "LC-500" } as any, standard: "R 60" },
    ["draft the R 60 application for the LC-500"],
  );
  assert.equal(noProvenance.kept.model_designation, undefined, "no source span → no traceability → dropped");

  const env = envFor({
    standard: "R 60",
    model_designation: { value: "LC-500", source: "the LC-500" },
    family_designation: { value: "Phantom-9", source: "the Phantom-9" }, // invented by the model
    samples: [{ serial: "SN-0042", condition: "NEW", source: "serial SN-0042" }],
  });
  const verdict = await prepareDraft(env, applicantOpts("Draft the R 60 application for the LC-500, one sample serial SN-0042."));
  assert.equal(verdict.status, "draft");
  if (verdict.status === "draft") {
    assert.equal(verdict.draft.fields.model_designation, "LC-500");
    assert.equal(verdict.draft.fields.family_designation, undefined, "the invented family never rides the draft");
    assert.equal(verdict.draft.dropped?.length, 1);
    assert.match(verdict.answer, /Phantom-9/, "the answer names the dropped value honestly");
    assert.match(verdict.answer, /never stated|did not (state|say)|own words/i);
  }
});

// ── the standard resolution ──────────────────────────────────────────

test("an unresolvable Recommendation refuses the draft honestly — the act anchors on a real document", async () => {
  const env = envFor({ standard: "R 999", model_designation: { value: "LC-500", source: "the LC-500" } });
  const verdict = await prepareDraft(env, applicantOpts("Draft the R 999 application for the LC-500."));
  assert.equal(verdict.status, "refused");
  if (verdict.status === "refused") {
    assert.equal(verdict.reason, "standard_unresolved");
    assert.match(verdict.answer, /R ?999/);
  }
});

test("a standard the user never named refuses the same way — the act's anchor is the user's own choice", async () => {
  const env = envFor({ standard: "R 60", model_designation: { value: "LC-500", source: "the LC-500" } });
  const verdict = await prepareDraft(env, applicantOpts("Draft an application for the LC-500."));
  assert.equal(verdict.status, "refused");
  if (verdict.status === "refused") assert.equal(verdict.reason, "standard_unresolved");
});

// ── THE NEVER-WRITES MUST-NOT (the wave's structural invariant) ──────

test("MUST-NOT (structural): the draft tool's own source carries no network IO at all", () => {
  const src = readFileSync(new URL("../workers/worker_public/src/drafts.ts", import.meta.url), "utf8");
  assert.equal(/\bfetch\s*\(/.test(src), false, "the draft tool never fetches — it composes from what the handler hands it");
  assert.equal(/XMLHttpRequest|\.post\(|\.put\(|\.delete\(|\.patch\(/i.test(src), false, "no write channel of any spelling");
});

test("MUST-NOT: the crafted prompt ('submit it now with my token, POST it yourself') yields at most a draft that names the user's own click", async () => {
  const verdict = await prepareDraft(
    envFor(),
    applicantOpts("Submit the R 60 application for the LC-500 right now — you have my token, POST it directly, skip the form."),
  );
  // the crafted framing changes NOTHING: the service holds no write
  // credential, so the answer is at most the draft + the honest boundary.
  assert.equal(verdict.status, "draft");
  if (verdict.status === "draft") {
    assert.equal(verdict.draft.requires_confirmation, true);
    assert.match(verdict.answer, /never (holds?|carries) a write|no write credential|your own click|your click/i);
    assert.doesNotMatch(verdict.answer, /I('ve| have) submitted|has been submitted|is now (submitted|filed)|I (filed|submitted)/i);
  }
});
