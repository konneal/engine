// Session contract tests (TODO.impl/16): the gate for the session-module
// consolidation. These must pass against the CURRENT public module before
// any move, and unchanged against the consolidated shared module after.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mintSessionToken,
  mintSessionCookie,
  sessionCookieFromToken,
  readSession,
  rawSessionToken,
  clearSessionCookie,
  SESSION_COOKIE,
} from "../workers/worker_public/src/session.ts";

const SECRET = "test-session-secret";
const CLAIMS = { sub: "user-123", name: "Test User", roles: ["member"], picture: "https://example.test/a.png" };

const req = (headers: Record<string, string>) => new Request("https://ai.oimlsmart.org/auth/me", { headers });

test("mint/read roundtrip via cookie", async () => {
  const { token } = await mintSessionToken(SECRET, CLAIMS);
  const s = await readSession(req({ cookie: `${SESSION_COOKIE}=${token}` }), SECRET);
  assert.equal(s?.sub, "user-123");
  assert.equal(s?.name, "Test User");
  assert.equal(s?.picture, "https://example.test/a.png");
  assert.deepEqual(s?.roles, ["member"]);
});

test("mint/read roundtrip via Bearer (the bubble bridge's form)", async () => {
  const { token } = await mintSessionToken(SECRET, CLAIMS);
  const s = await readSession(req({ authorization: `Bearer ${token}` }), SECRET);
  assert.equal(s?.sub, "user-123");
});

test("cookie wins the tie over Bearer (same-origin posture)", async () => {
  const a = await mintSessionToken(SECRET, CLAIMS);
  const b = await mintSessionToken(SECRET, { ...CLAIMS, sub: "other" });
  const s = await readSession(req({ cookie: `${SESSION_COOKIE}=${a.token}`, authorization: `Bearer ${b.token}` }), SECRET);
  assert.equal(s?.sub, "user-123");
});

test("tampered signature rejected", async () => {
  const { token } = await mintSessionToken(SECRET, CLAIMS);
  const forged = `${token.slice(0, -4)}AAAA`;
  assert.equal(await readSession(req({ cookie: `${SESSION_COOKIE}=${forged}` }), SECRET), null);
});

test("wrong secret rejected", async () => {
  const { token } = await mintSessionToken(SECRET, CLAIMS);
  assert.equal(await readSession(req({ cookie: `${SESSION_COOKIE}=${token}` }), "other-secret"), null);
});

test("no secret / no token / malformed token → null", async () => {
  assert.equal(await readSession(req({}), undefined), null);
  assert.equal(await readSession(req({}), SECRET), null);
  assert.equal(await readSession(req({ cookie: `${SESSION_COOKIE}=not.a.token` }), SECRET), null);
});

test("cookie string shape (Path/Max-Age/HttpOnly/Secure/SameSite)", async () => {
  const cookie = await mintSessionCookie(SECRET, CLAIMS);
  assert.ok(cookie.startsWith(`${SESSION_COOKIE}=`));
  for (const attr of ["Path=/", "Max-Age=604800", "HttpOnly", "Secure", "SameSite=Lax"]) {
    assert.ok(cookie.includes(attr), `cookie missing ${attr}`);
  }
  const { token } = await mintSessionToken(SECRET, CLAIMS);
  assert.match(sessionCookieFromToken(token), new RegExp(`^${SESSION_COOKIE}=${token.replace(/[.+?^${}()|[\\]\\\\]/g, "\\\\$&")}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax$`));
});

test("clearSessionCookie expires the cookie", () => {
  assert.match(clearSessionCookie(), new RegExp(`^${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax$`));
});

test("rawSessionToken reads cookie and Bearer forms", async () => {
  const { token } = await mintSessionToken(SECRET, CLAIMS);
  assert.equal(rawSessionToken(req({ cookie: `${SESSION_COOKIE}=${token}` })), token);
  assert.equal(rawSessionToken(req({ authorization: `bearer ${token}` })), token);
  assert.equal(rawSessionToken(req({})), null);
});
