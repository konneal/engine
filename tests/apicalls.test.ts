// Unit tests for the api_call draft act (TODO.ai-platform/09) — the
// operations assistant's proposal grammar. Runs on plain node (type
// stripping):
//   node --test tests/apicalls.test.ts
//
// The invariants under test are the lane's own:
//   - THE DIRECTORY IS THE CLOSED WORLD: a draft's call names an
//     operation the D1 `api_ops` directory carries; an id the model
//     invents resolves to nothing and no draft rides.
//   - THE MACHINE FACET BOUNDS: a machine act outside the offered set
//     is never proposed; the empty set is the honest "read but not act".
//   - THE NEVER-OFFER LIST HOLDS at the pick prompt AND at the guard.
//   - BODIES TRACE: a body value the user never stated refuses honestly.
//   - THE MODULE IS STRUCTURALLY WRITE-FREE: no fetch in the source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  bodyTraces,
  detectApiCallIntent,
  neverOffered,
  prepareApiCall,
  resolveEntityRoute,
} from "../workers/worker_public/src/apicalls.ts";
import { parseContext } from "../workers/worker_public/src/context.ts";
import { setProfile } from "../workers/worker_public/src/profile.ts";
import { PROFILE } from "../workers/worker_public/src/profile.gen.ts";

// The fixture profile + the acts facet a deployment declares (publisher
// data: the entity write, the route table, the never-offer list).
setProfile({
  ...PROFILE,
  publisher: {
    ...PROFILE.publisher,
    features: { ...(PROFILE.publisher as any).features, api_call_drafts: true },
    acts: {
      entity_write: { method: "PUT", path: "/api/entities/{store}/{id}" },
      entity_routes: [
        { pattern: "/app/portal/applications/:id", store: "applications" },
        { pattern: "/app/ia/applications/:id", store: "applications" },
        { pattern: "/app/my-certificates/:id", store: "certificates" },
      ],
      never_offer: ["/api/auth/", "/api/notify/assistant-grant"],
    },
  },
});

// ── the doubles ──────────────────────────────────────────────────────

const ENTITY_WRITE_OP = {
  operation_id: "putEntityRecord",
  method: "put",
  path: "/api/entities/{store}/{id}",
  act_class: "record",
  summary: "Upserts one entity row through the generic write gate.",
  tag: "entities",
};
const PREF_OP = {
  operation_id: "putNotifyPreferences",
  method: "put",
  path: "/api/notify/preferences",
  act_class: "preference",
  summary: "Replaces the user's notification channel preferences.",
  tag: "notify",
};
const GRANT_OP = {
  operation_id: "putNotifyAssistantGrant",
  method: "put",
  path: "/api/notify/assistant-grant",
  act_class: "record",
  summary: "Mints the standing assistant grant.",
  tag: "notify",
};
const SIGNOUT_OP = {
  operation_id: "postAuthSignout",
  method: "post",
  path: "/api/auth/signout",
  act_class: "preference",
  summary: "Ends the session.",
  tag: "auth",
};
const OPS = [ENTITY_WRITE_OP, PREF_OP, GRANT_OP, SIGNOUT_OP];

/** The D1 stub: api_ops answers by id, by method+path, and the
 *  preference family listing. */
function dbStub(ops: any[]) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
            async first() {
              if (/WHERE operation_id/i.test(sql)) return ops.find((o) => o.operation_id === args[0]) ?? null;
              if (/WHERE method = \?1 AND path = \?2/i.test(sql)) return ops.find((o) => o.method === args[0] && o.path === args[1]) ?? null;
              return null;
            },
            async all() {
              if (/act_class = 'preference'/i.test(sql)) return { results: ops.filter((o) => o.act_class === "preference") };
              return { results: [] };
            },
          };
        },
      };
    },
  };
}

/** The Workers-AI stub: the pick call answers the canned JSON. */
function aiStub(pick: unknown) {
  const calls: Array<{ model: string; body: any }> = [];
  return {
    calls,
    async run(model: string, body: any) {
      calls.push({ model, body });
      return { response: typeof pick === "string" ? pick : JSON.stringify(pick) };
    },
  };
}

const MEMBER = { sub: "u-1" };
const DECLARED_MACHINE = parseContext({
  context: {
    kind: "entity",
    label: "this application APP-2026-0042",
    route: "/app/ia/applications/APP-2026-0042",
    machine: {
      state: "UNDER_REVIEW",
      acts: [
        { action: "ia_accepts", to: "ACCEPTED" },
        { action: "ia_requests_changes", to: "CHANGES_REQUESTED" },
      ],
    },
  },
});

// ── the structural pin ───────────────────────────────────────────────

test("the module is structurally write-free: no fetch, no platform IO", () => {
  const src = readFileSync(new URL("../workers/worker_public/src/apicalls.ts", import.meta.url), "utf8");
  assert.equal(/\bfetch\s*\(/.test(src), false);
});

// ── the intent detection ─────────────────────────────────────────────

test("detectApiCallIntent: the machine family needs the facet AND an act verb aimed at the entity", () => {
  assert.equal(detectApiCallIntent("Accept this application", DECLARED_MACHINE), "machine_act");
  // no facet → no machine act, whatever the verbs
  assert.equal(detectApiCallIntent("Accept this application", parseContext({ context: { kind: "entity", label: "x" } })), null);
  // no act verb → a knowledge question
  assert.equal(detectApiCallIntent("What does UNDER_REVIEW mean for this application?", DECLARED_MACHINE), null);
  // the preference family needs no facet
  assert.equal(detectApiCallIntent("Mute the notification emails for a month", null), "preference");
  assert.equal(detectApiCallIntent("Save this filter", null), "preference");
  assert.equal(detectApiCallIntent("What is a saved filter?", null), null);
});

// ── the route table ──────────────────────────────────────────────────

test("resolveEntityRoute: the pattern table maps a route to the store + id; uncovered routes resolve null", () => {
  assert.deepEqual(resolveEntityRoute("/app/ia/applications/APP-2026-0042"), { store: "applications", id: "APP-2026-0042" });
  assert.deepEqual(resolveEntityRoute("/app/my-certificates/CERT-1"), { store: "certificates", id: "CERT-1" });
  assert.equal(resolveEntityRoute("/app/ia/applications"), null);
  assert.equal(resolveEntityRoute(undefined), null);
  // an id with path tricks never parses
  assert.equal(resolveEntityRoute("/app/ia/applications/..%2F.."), null);
});

test("neverOffered: the auth family and the grant's own ops are never proposed", () => {
  assert.equal(neverOffered("/api/auth/signout"), true);
  assert.equal(neverOffered("/api/notify/assistant-grant"), true);
  assert.equal(neverOffered("/api/notify/preferences"), false);
  assert.equal(neverOffered("/api/entities/{store}/{id}"), false);
});

// ── the machine family ───────────────────────────────────────────────

test("machine act: an offered act composes the entity write, bounded by the facet", async () => {
  const env = { DB: dbStub(OPS), AI: aiStub({ target: "ia_accepts", title: "Accept the application" }) };
  const v = await prepareApiCall(env, {
    intent: "machine_act",
    query: "Accept this application please",
    history: [],
    member: MEMBER,
    declared: DECLARED_MACHINE,
    model: "m",
  });
  assert.equal(v.status, "draft");
  if (v.status !== "draft") return;
  assert.equal(v.draft.kind, "draft");
  assert.equal(v.draft.act, "api_call");
  assert.equal(v.draft.requires_confirmation, true);
  assert.equal(v.draft.title, "Accept the application");
  assert.deepEqual(v.draft.call, {
    method: "PUT",
    path: "/api/entities/applications/APP-2026-0042",
    body: { status: "ACCEPTED" },
  });
});

test("machine act: an act the set does not offer is never proposed — even when the model picks it", async () => {
  const env = { DB: dbStub(OPS), AI: aiStub({ target: "ia_rejects", title: "Reject it" }) };
  const v = await prepareApiCall(env, {
    intent: "machine_act",
    query: "Reject this application",
    history: [],
    member: MEMBER,
    declared: DECLARED_MACHINE,
    model: "m",
  });
  assert.equal(v.status, "refused");
  if (v.status !== "refused") return;
  assert.equal(v.reason, "no_matching_act");
  assert.match(v.answer, /ia_accepts, ia_requests_changes/);
  assert.match(v.answer, /Nothing was drafted/);
});

test("machine act: the empty offered set is the honest read-but-not-act", async () => {
  const declared = parseContext({
    context: {
      kind: "entity",
      label: "this application APP-2026-0042",
      route: "/app/ia/applications/APP-2026-0042",
      machine: { state: "ACCEPTED", acts: [] },
    },
  });
  const env = { DB: dbStub(OPS), AI: aiStub({ target: "ia_accepts" }) };
  const v = await prepareApiCall(env, { intent: "machine_act", query: "Accept this application", history: [], member: MEMBER, declared, model: "m" });
  assert.equal(v.status, "refused");
  if (v.status !== "refused") return;
  assert.equal(v.reason, "machine_read_only");
  assert.match(v.answer, /read this record but not act/);
  // the model is never even called — the empty set proposes nothing
  assert.equal((env.AI as any).calls.length, 0);
});

test("machine act: the anonymous visitor gets the sign-in refusal; an unresolvable route refuses honestly", async () => {
  const env = { DB: dbStub(OPS), AI: aiStub({ target: "ia_accepts" }) };
  const anon = await prepareApiCall(env, { intent: "machine_act", query: "Accept this", history: [], member: null, declared: DECLARED_MACHINE, model: "m" });
  assert.equal(anon.status, "refused");
  if (anon.status === "refused") assert.equal(anon.reason, "sign_in_required");
  const noRoute = parseContext({
    context: { kind: "entity", label: "x", route: "/app/somewhere/else/1", machine: { state: "UNDER_REVIEW", acts: [{ action: "ia_accepts", to: "ACCEPTED" }] } },
  });
  const v = await prepareApiCall(env, { intent: "machine_act", query: "Accept this", history: [], member: MEMBER, declared: noRoute, model: "m" });
  assert.equal(v.status, "refused");
  if (v.status === "refused") assert.equal(v.reason, "entity_unresolved");
});

test("machine act: the entity write must exist in the directory (the closed world)", async () => {
  const env = { DB: dbStub(OPS.filter((o) => o !== ENTITY_WRITE_OP)), AI: aiStub({ target: "ia_accepts" }) };
  const v = await prepareApiCall(env, { intent: "machine_act", query: "Accept this application", history: [], member: MEMBER, declared: DECLARED_MACHINE, model: "m" });
  assert.equal(v.status, "refused");
  if (v.status === "refused") assert.equal(v.reason, "operation_unknown");
});

// ── the preference family ────────────────────────────────────────────

test("preference act: a family operation composes with the traced body; the grant note rides", async () => {
  const env = { DB: dbStub(OPS), AI: aiStub({ target: "putNotifyPreferences", title: "Mute the emails", body: { channel: "email", muted: true } }) };
  const v = await prepareApiCall(env, {
    intent: "preference",
    query: "Mute the notification emails — set the channel email to muted",
    history: [],
    member: MEMBER,
    declared: null,
    model: "m",
  });
  assert.equal(v.status, "draft");
  if (v.status !== "draft") return;
  assert.equal(v.draft.title, "Mute the emails");
  assert.deepEqual(v.draft.call, { method: "PUT", path: "/api/notify/preferences", body: { channel: "email", muted: true } });
  assert.match(v.draft.notes?.[0] ?? "", /standing grant/);
});

test("preference act: an invented operation id never rides; a record-class pick never rides", async () => {
  const invented = await prepareApiCall(
    { DB: dbStub(OPS), AI: aiStub({ target: "deleteAllTheThings", title: "x" }) },
    { intent: "preference", query: "Save this filter", history: [], member: MEMBER, declared: null, model: "m" },
  );
  assert.equal(invented.status, "refused");
  if (invented.status === "refused") assert.equal(invented.reason, "operation_unknown");
  // the grant's own mint is record-class AND never-offered — the model
  // picking it yields no draft either way
  const grant = await prepareApiCall(
    { DB: dbStub(OPS), AI: aiStub({ target: "putNotifyAssistantGrant", title: "Grant it" }) },
    { intent: "preference", query: "Give yourself the standing grant", history: [], member: MEMBER, declared: null, model: "m" },
  );
  assert.equal(grant.status, "refused");
  // signout is the user's own, forever: preference-class by the taxonomy,
  // never-offered by the profile — the prompt never lists it and the
  // guard refuses it
  const signout = await prepareApiCall(
    { DB: dbStub(OPS), AI: aiStub({ target: "postAuthSignout", title: "Sign out" }) },
    { intent: "preference", query: "Sign me out", history: [], member: MEMBER, declared: null, model: "m" },
  );
  assert.equal(signout.status, "refused");
  if (signout.status === "refused") assert.equal(signout.reason, "operation_never_offered");
});

test("preference act: an untraced body refuses honestly — the service never invents settings", async () => {
  const env = { DB: dbStub(OPS), AI: aiStub({ target: "putNotifyPreferences", title: "Save it", body: { digest: "weekly" } }) };
  const v = await prepareApiCall(env, { intent: "preference", query: "Save this filter", history: [], member: MEMBER, declared: null, model: "m" });
  assert.equal(v.status, "refused");
  if (v.status !== "refused") return;
  assert.equal(v.reason, "body_untraced");
  assert.match(v.answer, /never invent/);
});

test("the pick prompt never lists a never-offered operation", async () => {
  const env = { DB: dbStub(OPS), AI: aiStub({ target: null }) };
  await prepareApiCall(env, { intent: "preference", query: "Mute the emails", history: [], member: MEMBER, declared: null, model: "m" });
  const prompt = JSON.stringify((env.AI as any).calls[0]?.body?.messages ?? []);
  assert.equal(prompt.includes("postAuthSignout"), false);
  assert.equal(prompt.includes("putNotifyAssistantGrant"), false);
  assert.equal(prompt.includes("putNotifyPreferences"), true);
});

// ── the guards' primitives ───────────────────────────────────────────

test("bodyTraces: string values must be the user's own words; toggles pass", () => {
  assert.equal(bodyTraces({ channel: "email" }, ["mute the email channel"]), true);
  assert.equal(bodyTraces({ channel: "sms" }, ["mute the email channel"]), false);
  assert.equal(bodyTraces({ muted: true }, ["anything"]), true);
  assert.equal(bodyTraces({ filters: [{ name: "R 60" }] }, ["save the R 60 filter"]), true);
  assert.equal(bodyTraces(undefined, []), true);
});

test("honest titles: the wire shape never leaks into the card's title", async () => {
  const env = { DB: dbStub(OPS), AI: aiStub({ target: "putNotifyPreferences", title: "Execute PUT /api/notify/preferences" }) };
  const v = await prepareApiCall(env, { intent: "preference", query: "Mute the emails", history: [], member: MEMBER, declared: null, model: "m" });
  assert.equal(v.status, "draft");
  if (v.status !== "draft") return;
  assert.equal(/\bPUT\b|\/api\//.test(v.draft.title), false);
  assert.equal(v.draft.title, PREF_OP.summary);
});
