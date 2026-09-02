// The bubble bridge's unit legs (TODO.ai-platform/01): the origin
// allowlist, the session token mint/verify round-trip, the cookie-vs-
// bearer precedence, and the confirm page's escaping. Runs on Node's
// type stripping (the imported worker sources are erasable-syntax only).
//   node --test tests/bridge.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedBubbleOrigin, bubbleConfirmPage } from "../workers/worker_public/src/bubble.ts";
import { mintSessionToken, readSession, SESSION_COOKIE } from "../workers/worker_public/src/session.ts";
import { readSession as readSessionShared } from "../workers/shared/session.ts";

const SECRET = "test-secret-not-real";

test("origin allowlist: the estate pattern + localhost only", () => {
  for (const ok of [
    "https://oimlsmart.org",
    "https://www.oimlsmart.org",
    "https://app.oimlsmart.org",
    "https://ai.oimlsmart.org",
    "http://localhost:5190",
    "http://localhost",
    "http://127.0.0.1:4173",
  ]) {
    assert.equal(isAllowedBubbleOrigin(ok), true, ok);
  }
  for (const no of [
    "",
    "https://evil.com",
    "https://oimlsmart.org.evil.com",
    "https://evil-oimlsmart.org",
    "http://oimlsmart.org", // plain http off localhost
    "https://OIMLSMART.ORG.evil.com",
    "javascript:alert(1)",
    "https://oimlsmart.org@evil.com",
    "null",
  ]) {
    assert.equal(isAllowedBubbleOrigin(no), false, no);
  }
});

function bearerReq(token, extra = {}) {
  return new Request("https://ai.oimlsmart.org/auth/me", {
    headers: { authorization: `Bearer ${token}`, ...extra },
  });
}

test("session token: mint → bearer verify round-trip", async () => {
  const { token, expiresAt } = await mintSessionToken(SECRET, { sub: "u-1", name: "R. Tse", roles: ["viewer"] });
  assert.ok(expiresAt > Date.now());
  const claims = await readSession(bearerReq(token), SECRET);
  assert.equal(claims?.sub, "u-1");
  assert.equal(claims?.name, "R. Tse");
});

test("session token: wrong secret, tamper, and junk all refuse", async () => {
  const { token } = await mintSessionToken(SECRET, { sub: "u-1", roles: [] });
  assert.equal(await readSession(bearerReq(token), "another-secret"), null);
  const [payload] = token.split(".");
  assert.equal(await readSession(bearerReq(`${payload}.${"a".repeat(43)}`), SECRET), null);
  assert.equal(await readSession(bearerReq("not-a-token"), SECRET), null);
  assert.equal(await readSession(new Request("https://ai.oimlsmart.org/auth/me"), SECRET), null);
});

test("cookie wins over bearer; bearer serves when no cookie", async () => {
  const cookieTok = (await mintSessionToken(SECRET, { sub: "cookie-user", roles: [] })).token;
  const bearerTok = (await mintSessionToken(SECRET, { sub: "bearer-user", roles: [] })).token;
  const both = await readSession(bearerReq(bearerTok, { cookie: `${SESSION_COOKIE}=${cookieTok}` }), SECRET);
  assert.equal(both?.sub, "cookie-user");
  const bearerOnly = await readSession(bearerReq(bearerTok), SECRET);
  assert.equal(bearerOnly?.sub, "bearer-user");
});

test("the shared session module (the internal worker's copy) accepts the bearer form", async () => {
  // worker_internal gates the federation hop with workers/shared/session.ts —
  // the bubble member's ISO/IEC federation rides this path.
  const { token } = await mintSessionToken(SECRET, { sub: "member-1", roles: [] });
  const claims = await readSessionShared(bearerReq(token), SECRET);
  assert.equal(claims?.sub, "member-1");
  assert.equal(await readSessionShared(bearerReq("junk"), SECRET), null);
});

test("confirm page: exact targetOrigin, escaped name, no script breakout", () => {
  const evilName = `</script><img src=x onerror=alert(1)>`;
  const html = bubbleConfirmPage({
    name: evilName,
    origin: "https://www.oimlsmart.org",
    token: "tok.en",
    expiresAt: 1_800_000_000_000,
  });
  assert.ok(html.includes('var TARGET = "https:\\u002f\\u002fwww.oimlsmart.org"'.replaceAll("\\u002f", "/")) || html.includes('"https://www.oimlsmart.org"'), "targetOrigin is the validated origin");
  assert.ok(!html.includes("evil.com"), "no foreign origin leaks in");
  assert.ok(html.includes("&lt;/script&gt;"), "the name is HTML-escaped in the copy");
  // the JSON payload embedded in the script escapes '<' as < — the
  // literal '</script>' must appear ONLY as the page's own closing tag
  const scriptCloseCount = (html.match(/<\/script>/g) ?? []).length;
  assert.equal(scriptCloseCount, 1, "exactly the page's own </script>");
  assert.ok(html.includes("tok.en"), "the token rides the payload");
  assert.ok(!html.includes('postMessage(PAYLOAD, "*"'), "never a wildcard targetOrigin");
});
