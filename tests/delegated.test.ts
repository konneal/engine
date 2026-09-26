// The delegated bearer (TODO.ai-platform/12 — the session bridge): the
// OP-minted RFC 8693 JWT admits the member lane when the deployment opts
// in. Every refusal resolves to null (the anonymous tier), honestly.

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { delegatedBearerFrom } from "../workers/worker_public/src/delegated.ts";
import { liveTokenFor } from "../workers/worker_public/src/livedata.ts";
import { setProfile } from "../workers/worker_public/src/profile.ts";
import { PROFILE } from "../workers/worker_public/src/profile.gen.ts";

const ISSUER = "https://id.example.org";
const CLIENT_ID = "oiml-ai";
const PLATFORM_CLIENT = "oiml-smart";

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const otherPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
const JWKS = { keys: [{ ...publicJwk, kid: "k1", alg: "ES256", use: "sig" }] };

const b64u = (s: string) => Buffer.from(s, "utf8").toString("base64url");

async function mintJwt(claims: Record<string, unknown>, key: CryptoKey = pair.privateKey): Promise<string> {
  const header = b64u(JSON.stringify({ alg: "ES256", kid: "k1", typ: "JWT" }));
  const payload = b64u(JSON.stringify(claims));
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${Buffer.from(new Uint8Array(sig)).toString("base64url")}`;
}

const nowSec = () => Math.floor(Date.now() / 1000);

function validClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    sub: "acct-7",
    aud: [PLATFORM_CLIENT],
    iat: nowSec() - 60,
    exp: nowSec() + 300,
    scope: `${PLATFORM_CLIENT}:read`,
    name: "Case Officer",
    email: "officer@example.org",
    service_roles: { [PLATFORM_CLIENT]: ["officer"], [CLIENT_ID]: ["member"] },
    act: { sub: PLATFORM_CLIENT },
    ...over,
  };
}

const env = { OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: CLIENT_ID };

const reqWith = (token: string | null) =>
  new Request("https://ops.example.org/api/ask", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

function delegatedProfile(on: boolean): unknown {
  const pub = PROFILE.publisher as any;
  return {
    ...PROFILE,
    publisher: {
      ...pub,
      features: { ...(pub.features ?? {}), delegated_bearer: on },
      identity: { ...(pub.identity ?? {}), delegators: [PLATFORM_CLIENT] },
    },
  };
}

const originalFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return new Response(
        JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/op/authorize`,
          token_endpoint: `${ISSUER}/op/token`,
          jwks_uri: `${ISSUER}/jwks`,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === `${ISSUER}/jwks`) {
      return new Response(JSON.stringify(JWKS), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

test("a valid delegated JWT admits the member lane with the delegation marks", async () => {
  setProfile(delegatedProfile(true));
  const claims = await delegatedBearerFrom(reqWith(await mintJwt(validClaims())), env);
  assert.ok(claims);
  assert.equal(claims.sub, "acct-7");
  assert.equal(claims.via, "delegated");
  assert.equal(claims.delegator, PLATFORM_CLIENT);
  assert.equal(claims.scope, `${PLATFORM_CLIENT}:read`);
  assert.deepEqual(claims.roles, ["member"]); // THIS service's cone, never the delegator's
  // exp carried and scaled seconds → ms (minted from validClaims' exp)
  assert.ok(Math.abs(claims.exp - (nowSec() + 300) * 1000) < 120_000);
});

test("the expired delegation refuses honestly", async () => {
  setProfile(delegatedProfile(true));
  const token = await mintJwt(validClaims({ exp: nowSec() - 3600 }));
  assert.equal(await delegatedBearerFrom(reqWith(token), env), null);
});

test("a foreign issuer refuses honestly (the signature still verifies — the claim is the lie)", async () => {
  setProfile(delegatedProfile(true));
  const token = await mintJwt(validClaims({ iss: "https://id.evil.example.org" }));
  assert.equal(await delegatedBearerFrom(reqWith(token), env), null);
});

test("an undeclared delegating surface refuses (the delegators allowlist fails closed)", async () => {
  setProfile(delegatedProfile(true));
  const token = await mintJwt(validClaims({ act: { sub: "some-other-platform" } }));
  assert.equal(await delegatedBearerFrom(reqWith(token), env), null);
});

test("a plain access token without the act claim is NOT a member credential", async () => {
  setProfile(delegatedProfile(true));
  const { act: _drop, ...noAct } = validClaims();
  const token = await mintJwt(noAct);
  assert.equal(await delegatedBearerFrom(reqWith(token), env), null);
});

test("a forged signature refuses honestly", async () => {
  setProfile(delegatedProfile(true));
  const token = await mintJwt(validClaims(), otherPair.privateKey);
  assert.equal(await delegatedBearerFrom(reqWith(token), env), null);
});

test("the feature flag gates the lane: profile without delegated_bearer admits nothing", async () => {
  setProfile(delegatedProfile(false));
  const token = await mintJwt(validClaims());
  assert.equal(await delegatedBearerFrom(reqWith(token), env), null);
});

test("no issuer configured → the lane is dark", async () => {
  setProfile(delegatedProfile(true));
  const token = await mintJwt(validClaims());
  assert.equal(await delegatedBearerFrom(reqWith(token), {}), null);
});

test("the two-segment service session token never reaches the verifier", async () => {
  setProfile(delegatedProfile(true));
  assert.equal(await delegatedBearerFrom(reqWith("payload.hmacsig"), env), null);
  assert.equal(await delegatedBearerFrom(reqWith(null), env), null);
});

test("liveTokenFor: the delegated bearer IS the platform read token when the scope covers it", async () => {
  const liveEnv = {
    ...env,
    SMART_PLATFORM_API: "https://demo.example.org",
    SMART_PLATFORM_CLIENT_ID: PLATFORM_CLIENT,
  };
  const token = await mintJwt(validClaims());
  const verdict = await liveTokenFor(liveEnv, token, { via: "delegated", scope: `${PLATFORM_CLIENT}:read` });
  assert.deepEqual(verdict, { ok: true, token });
});

test("liveTokenFor: a service session (no via mark) falls through to the exchange path", async () => {
  // No CACHE binding in this env: the exchange answers window_expired,
  // proving the fall-through ran instead of the direct present.
  const liveEnv = {
    ...env,
    SMART_PLATFORM_API: "https://demo.example.org",
    SMART_PLATFORM_CLIENT_ID: PLATFORM_CLIENT,
    CACHE: { get: async () => null, put: async () => {}, delete: async () => {} },
  };
  const verdict = await liveTokenFor(liveEnv, "session.hmac", { sub: "acct-7" } as any);
  assert.deepEqual(verdict, { ok: false, reason: "window_expired" });
});
