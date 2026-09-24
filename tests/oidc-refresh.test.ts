import assert from "node:assert/strict";
import { test } from "node:test";
import { renewedSessionClaims, refreshGrant } from "../workers/worker_public/src/refresh-core.ts";

const session = {
  sub: "acct-1",
  name: "Old Name",
  email: "old@example.org",
  picture: undefined,
  roles: ["viewer"],
  iat: Date.now() - 3_600_000,
  exp: Date.now() + 6 * 24 * 3600 * 1000,
};

const claimsOf = (over: Record<string, unknown>) =>
  ({ iss: "x", aud: "x", exp: 9, iat: 9, sub: "acct-1", name: "New Name", email: "new@example.org", picture: "https://op/avatar/1", roles: ["member"], ...over } as any);

test("the sub guard: a different account is a provisioning error, never an update", () => {
  assert.equal(renewedSessionClaims(session, claimsOf({ sub: "acct-2" })), null);
  assert.ok(renewedSessionClaims(session, claimsOf({})));
});

test("fresh claims win; an omitted claim never erases what the user had", () => {
  const fresh = renewedSessionClaims(session, claimsOf({}));
  assert.equal(fresh?.name, "New Name");
  assert.equal(fresh?.picture, "https://op/avatar/1");
  assert.deepEqual(fresh?.roles, ["member"]);
  const partial = renewedSessionClaims(session, claimsOf({ picture: undefined, roles: undefined, name: undefined }));
  assert.equal(partial?.picture, undefined); // the session had none either
  assert.equal(partial?.name, "Old Name");
  assert.deepEqual(partial?.roles, ["viewer"]);
});

test("the refresh grant classifies a refusal as refused (revocation)", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as any;
  try {
    const r = await refreshGrant({ token_endpoint: "https://id.example.org/op/token", jwks_uri: "https://id.example.org/jwks" }, { clientId: "c" }, "rt");
    assert.equal(r.kind, "refused");
  } finally {
    globalThis.fetch = original;
  }
});

test("the refresh grant classifies a network throw as unavailable", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("down"); }) as any;
  try {
    const r = await refreshGrant({ token_endpoint: "https://id.example.org/op/token", jwks_uri: "https://id.example.org/jwks" }, { clientId: "c" }, "rt");
    assert.equal(r.kind, "unavailable");
  } finally {
    globalThis.fetch = original;
  }
});
