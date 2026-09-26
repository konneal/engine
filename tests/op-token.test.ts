// The Ommisa tier (RFC 7662): the device-grant CLI's opaque bearer is
// admitted through the OP's introspection, judged against the
// deployment's allowlist. Every refusal resolves to null — honestly.

import assert from "node:assert/strict";
import { test } from "node:test";
import { deviceClientIds, opCfg, opMemberCanWrite, opMemberFromIntrospection, opTokenMember } from "../workers/worker_public/src/livedata.ts";

function bearer(token: string): Request {
  return new Request("https://ai.example.org/api/ask", { headers: { authorization: `Bearer ${token}` } });
}

function kv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(k: string, _t?: string) {
      const v = store.get(k);
      return v === undefined ? v : JSON.parse(v);
    },
    async put(k: string, v: string) {
      store.set(k, v);
    },
  };
}

test("deviceClientIds parses the allowlist; empty is off", () => {
  assert.deepEqual(deviceClientIds({ OIDC_DEVICE_CLIENT_IDS: " oiml-ommisa, other-cli " }), ["oiml-ommisa", "other-cli"]);
  assert.deepEqual(deviceClientIds({}), []);
  assert.deepEqual(deviceClientIds({ OIDC_DEVICE_CLIENT_IDS: "" }), []);
});

test("an active, allowlisted introspection answer resolves to the member credential", () => {
  const member = opMemberFromIntrospection({ active: true, client_id: "oiml-ommisa", sub: "acct-9", scope: "ai:read oiml:read" }, ["oiml-ommisa"]);
  assert.deepEqual(member, { sub: "acct-9", scope: "ai:read oiml:read", via: "op-token" });
});

test("inactive, foreign-client or subject-less answers are null", () => {
  assert.equal(opMemberFromIntrospection({ active: false }, ["oiml-ommisa"]), null);
  assert.equal(opMemberFromIntrospection({ active: true, client_id: "someone-else", sub: "acct-9" }, ["oiml-ommisa"]), null);
  assert.equal(opMemberFromIntrospection({ active: true, client_id: "oiml-ommisa" }, ["oiml-ommisa"]), null);
  assert.equal(opMemberFromIntrospection(null, ["oiml-ommisa"]), null);
});

test("opCfg reads the OP coordinates; opMemberCanWrite judges the scope", () => {
  assert.deepEqual(opCfg({ OIDC_ISSUER: " https://id.example.org/ ", OIDC_CLIENT_ID: "oiml-ai" }), {
    issuer: "https://id.example.org",
    clientId: "oiml-ai",
  });
  // a service session is full-strength; the bearer needs a stated write
  assert.equal(opMemberCanWrite({ via: "op-token", scope: "oiml-ai:read offline_access" }), false);
  assert.equal(opMemberCanWrite({ via: "op-token", scope: "oiml-ai:read oiml-ai:write offline_access" }), true);
  assert.equal(opMemberCanWrite({ sub: "s", roles: [] }), true);
  assert.equal(opMemberCanWrite(null), false);
});

test("opTokenMember introspects once, caches the raw answer, and excludes JWTs", async () => {
  let calls = 0;
  const token = "opaque-device-token-1";
  const env = {
    OIDC_DEVICE_CLIENT_IDS: "oiml-ommisa",
    OIDC_ISSUER: "https://id.example.org",
    OIDC_CLIENT_ID: "oiml-ai",
    CACHE: kv(),
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init?: any) => {
    calls++;
    assert.equal(String(_url), "https://id.example.org/op/introspect");
    assert.ok(String(init.body).includes("client_id=oiml-ai"));
    return new Response(JSON.stringify({ active: true, client_id: "oiml-ommisa", sub: "acct-9", scope: "ai:read" }), { headers: { "content-type": "application/json" } });
  }) as any;
  try {
    const first = await opTokenMember(env, { issuer: "https://id.example.org", clientId: "oiml-ai" }, bearer(token));
    assert.deepEqual(first, { sub: "acct-9", scope: "ai:read", via: "op-token" });
    const second = await opTokenMember(env, { issuer: "https://id.example.org", clientId: "oiml-ai" }, bearer(token));
    assert.deepEqual(second, first);
    assert.equal(calls, 1);
    // a JWT is the delegated lane's shape — never introspected
    assert.equal(await opTokenMember(env, { issuer: "https://id.example.org", clientId: "oiml-ai" }, bearer("h.p.s")), null);
    // the empty allowlist gates the tier entirely
    assert.equal(await opTokenMember({ ...env, OIDC_DEVICE_CLIENT_IDS: "" }, { issuer: "https://id.example.org", clientId: "oiml-ai" }, bearer(token)), null);
    // an unreachable OP resolves honestly to null
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as any;
    assert.equal(await opTokenMember({ ...env, CACHE: kv() }, { issuer: "https://id.example.org", clientId: "oiml-ai" }, bearer("another-opaque")), null);
  } finally {
    globalThis.fetch = origFetch;
  }
});
