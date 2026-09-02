// Unit tests for the live-data tool (TODO.ai-platform/03) — the "my
// account" context's service half. Runs on plain node (type stripping):
//   node --test tests/live-data.test.ts
//
// The cone-boundary posture under test is STRUCTURAL: the service maps
// the platform's answers 1:1 into records — it can never invent a row
// the platform did not return (the platform's own bearer-cone suite in
// oimlsmart/smart enforces the boundary server-side; here we prove the
// service side never widens, never caches past the window, and degrades
// honestly).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dropOpAccessToken,
  exchangeForLiveToken,
  liveDataConfig,
  readMyAccount,
  resolveLiveAccount,
  retainOpAccessToken,
} from "../workers/worker_public/src/livedata.ts";

// ── the doubles ──────────────────────────────────────────────────────

function kvStub() {
  const map = new Map<string, string>();
  return {
    map,
    async get(key: string, type?: string) {
      const v = map.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      map.set(key, value);
    },
    async delete(key: string) {
      map.delete(key);
    },
  };
}

const CFG_ENV = {
  OIDC_ISSUER: "https://id.example",
  OIDC_CLIENT_ID: "ai-assistant",
  OIDC_CLIENT_SECRET: "s3cret",
  SMART_PLATFORM_API: "https://hub.example",
  SMART_PLATFORM_CLIENT_ID: "oiml-smart",
};

/** A fake platform JWT whose payload carries the given platform roles
 *  (the service only ever DECODES its own fetched token for the page
 *  family — never re-validates). */
function fakeJwt(roles: string[]): string {
  const payload = Buffer.from(JSON.stringify({ sub: "u-1", service_roles: { "oiml-smart": roles } })).toString("base64url");
  return `head.${payload}.sig`;
}

/** A fetch stub from a route table: [method, url-prefix] → response.
 *  Records every call (the never-re-post / never-leak assertions read
 *  it). */
function fetchStub(routes: Array<{ method?: string; prefix: string; status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; method: string; auth: string | null; body: string | null }> = [];
  const f = async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, auth: init?.headers?.authorization ?? null, body: init?.body ? String(init.body) : null });
    const route = routes.find((r) => (r.method ?? "GET") === method && url.startsWith(r.prefix));
    if (!route) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetch: f as typeof fetch };
}

function withFetch(f: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const saved = globalThis.fetch;
  globalThis.fetch = f;
  return fn().finally(() => {
    globalThis.fetch = saved;
  });
}

// ── the retention + the exchange window ──────────────────────────────

test("the sign-in retains the OP access token for the session's window, keyed by the session hash", async () => {
  const env = { ...CFG_ENV, CACHE: kvStub() };
  await retainOpAccessToken(env, "session-token-abc", "op-access-xyz", 3600);
  const keys = [...env.CACHE.map.keys()];
  assert.equal(keys.length, 1);
  assert.match(keys[0]!, /^opat:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(env.CACHE.map.get(keys[0]!)).includes("session-token-abc"), false, "the key is the hash, never the token");
  assert.equal(JSON.parse(env.CACHE.map.get(keys[0]!)!).token, "op-access-xyz");
  // The drop closes the window deliberately.
  await dropOpAccessToken(env, "session-token-abc");
  assert.equal(env.CACHE.map.size, 0);
});

test("the exchange posts the RFC 8693 delegation with the service's client auth + the narrowed scope", async () => {
  const env = { ...CFG_ENV, CACHE: kvStub() };
  await retainOpAccessToken(env, "session-token-abc", "op-access-xyz", 3600);
  const stub = fetchStub([
    { method: "POST", prefix: "https://id.example/op/token", body: { access_token: "exchanged-jwt", expires_in: 3600, scope: "oiml-smart:read" } },
  ]);
  await withFetch(stub.fetch, async () => {
    const verdict = await exchangeForLiveToken(env, "session-token-abc");
    assert.deepEqual(verdict, { ok: true, token: "exchanged-jwt" });
  });
  assert.equal(stub.calls.length, 1);
  const call = stub.calls[0]!;
  assert.equal(call.method, "POST");
  assert.equal(call.auth, `Basic ${Buffer.from("ai-assistant:s3cret").toString("base64")}`);
  const form = new URLSearchParams(call.body!);
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:token-exchange");
  assert.equal(form.get("subject_token_type"), "urn:ietf:params:oauth:token-type:access_token");
  assert.equal(form.get("subject_token"), "op-access-xyz");
  assert.equal(form.get("scope"), "oiml-smart:read");
});

test("the exchanged token caches within the window — the second ask never re-posts", async () => {
  const env = { ...CFG_ENV, CACHE: kvStub() };
  await retainOpAccessToken(env, "session-token-abc", "op-access-xyz", 3600);
  const stub = fetchStub([
    { method: "POST", prefix: "https://id.example/op/token", body: { access_token: "exchanged-jwt", expires_in: 3600 } },
  ]);
  await withFetch(stub.fetch, async () => {
    await exchangeForLiveToken(env, "session-token-abc");
    const again = await exchangeForLiveToken(env, "session-token-abc");
    assert.deepEqual(again, { ok: true, token: "exchanged-jwt" });
  });
  assert.equal(stub.calls.length, 1, "the cache absorbs the second exchange");
});

test("the window's honest states: no subject, no member, no config, the refusal lattice", async () => {
  const env = { ...CFG_ENV, CACHE: kvStub() };
  // No retained token (the window lapsed or never opened).
  assert.deepEqual(await exchangeForLiveToken(env, "nobody"), { ok: false, reason: "window_expired" });
  // The composed resolution: the member is required.
  assert.deepEqual(await resolveLiveAccount(env, "session-token-abc", null), { status: "unavailable", reason: "sign_in_required" });
  // The deployment without the platform wiring says so.
  const noCfg = { CACHE: kvStub(), OIDC_ISSUER: "https://id.example", OIDC_CLIENT_ID: "ai-assistant" };
  assert.equal(liveDataConfig(noCfg), null);
  assert.deepEqual(await resolveLiveAccount(noCfg, "session-token-abc", { sub: "u-1" }), { status: "unavailable", reason: "not_configured" });
  // The OP's refusal: invalid_grant (the standing fell away / the
  // subject died) reads as the lapsed window; anything else is a plain
  // refusal.
  await retainOpAccessToken(env, "session-token-abc", "op-access-xyz", 3600);
  const granted400 = fetchStub([{ method: "POST", prefix: "https://id.example/op/token", status: 400, body: { error: "invalid_grant" } }]);
  await withFetch(granted400.fetch, async () => {
    assert.deepEqual(await exchangeForLiveToken(env, "session-token-abc"), { ok: false, reason: "window_expired" });
  });
  const refused = fetchStub([{ method: "POST", prefix: "https://id.example/op/token", status: 400, body: { error: "invalid_client" } }]);
  await withFetch(refused.fetch, async () => {
    assert.deepEqual(await exchangeForLiveToken(env, "session-token-abc"), { ok: false, reason: "refused" });
  });
});

// ── the platform reads (the structural must-not) ─────────────────────

const PLATFORM_ROWS = {
  applications: [
    { id: "app-1", application_number: "APP-2026-001", manufacturer_id: "mfr-acme", issuing_authority_id: "EX1", standard_id: "oiml-r60", status: "SUBMITTED", submitted_date: "2026-08-20" },
  ],
  certificates: [
    { id: "cert-1", certificate_number: "R60/2021-A-EX1-26.01", standard_id: "oiml-r60", status: "ISSUED", issue_date: "2026-08-01" },
  ],
  testRequests: [
    { id: "tr-1", request_number: "TR-2026-007", application_id: "app-1", status: "DISPATCHED", issued_date: "2026-08-25" },
  ],
  progress: { application: { id: "app-1", status: "SUBMITTED" }, stages: [], requests: [{ id: "tr-1", status: "DISPATCHED" }], evaluation: { state: "in_progress" }, certificate: null },
};

test("the records map the platform's answers 1:1 — never an invented row, a refused store contributes nothing", async () => {
  const env = { ...CFG_ENV, CACHE: kvStub() };
  const cfg = liveDataConfig(env)!;
  const stub = fetchStub([
    { prefix: "https://hub.example/api/entities/applications/app-1/progress", body: PLATFORM_ROWS.progress },
    { prefix: "https://hub.example/api/entities/applications", body: PLATFORM_ROWS.applications },
    // The cone refuses the certificates list outright (a 403) — it
    // contributes NOTHING, honestly.
    { prefix: "https://hub.example/api/entities/certificates", status: 403, body: { error: "forbidden" } },
    { prefix: "https://hub.example/api/entities/testRequests", body: PLATFORM_ROWS.testRequests },
  ]);
  const token = fakeJwt(["applicant"]);
  await withFetch(stub.fetch, async () => {
    const read = await readMyAccount(env, cfg, token);
    assert.equal(read.ok, true);
    if (read.ok) {
      // EXACTLY the rows the platform answered — no more, no less.
      assert.deepEqual(
        read.records.map((r) => r.id).sort(),
        ["app-1", "tr-1"],
      );
      assert.deepEqual(read.stores, ["applications", "testRequests"]);
      const appRecord = read.records.find((r) => r.id === "app-1")!;
      assert.equal(appRecord.label, "Application APP-2026-001 — R 60");
      assert.equal(appRecord.url, "https://hub.example/app/portal/applications/app-1");
      assert.equal(appRecord.status, "SUBMITTED");
      assert.match(appRecord.detail ?? "", /evaluation in progress/);
      assert.match(appRecord.detail ?? "", /1 test request dispatched/);
      // Every read carried the delegated token.
      for (const call of stub.calls) assert.equal(call.auth, `Bearer ${token}`, "the read rides the exchanged token");
    }
  });
});

test("the record links follow the reader's console family (the page their own browser opens)", async () => {
  const env = { ...CFG_ENV, CACHE: kvStub() };
  const cfg = liveDataConfig(env)!;
  const stub = fetchStub([
    { prefix: "https://hub.example/api/entities/applications", body: PLATFORM_ROWS.applications },
    { prefix: "https://hub.example/api/entities/certificates", body: [] },
    { prefix: "https://hub.example/api/entities/testRequests", body: [] },
  ]);
  await withFetch(stub.fetch, async () => {
    const ia = await readMyAccount(env, cfg, fakeJwt(["ia_officer"]));
    assert.equal(ia.ok && ia.records[0]?.url, "https://hub.example/app/ia/applications/app-1");
    const lab = await readMyAccount(env, cfg, fakeJwt(["tl_operator"]));
    assert.equal(lab.ok && lab.records[0]?.url, "https://hub.example/app/lab/projects/app-1");
  });
});

test("the composed resolution answers the records + the read echo", async () => {
  const env = { ...CFG_ENV, CACHE: kvStub() };
  await retainOpAccessToken(env, "session-token-abc", "op-access-xyz", 3600);
  const stub = fetchStub([
    { method: "POST", prefix: "https://id.example/op/token", body: { access_token: fakeJwt(["applicant"]), expires_in: 3600 } },
    { prefix: "https://hub.example/api/entities/applications/app-1/progress", body: PLATFORM_ROWS.progress },
    { prefix: "https://hub.example/api/entities/applications", body: PLATFORM_ROWS.applications },
    { prefix: "https://hub.example/api/entities/certificates", body: [] },
    { prefix: "https://hub.example/api/entities/testRequests", body: [] },
  ]);
  await withFetch(stub.fetch, async () => {
    const live = await resolveLiveAccount(env, "session-token-abc", { sub: "u-1" });
    assert.equal(live.status, "ok");
    if (live.status === "ok") {
      assert.equal(live.records.length, 1);
      assert.deepEqual(live.stores, ["applications", "certificates", "testRequests"]);
      assert.ok(live.readAt);
    }
  });
});
