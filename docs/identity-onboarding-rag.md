# The RAG service's identity onboarding — what to fix now

The companion to docs/identity-service.md (the general guide): the
RAG-specific fix-and-verify list. The OP side is done — the
`oiml-rag` client is registered and ACTIVE (public PKCE client;
`claims_policy: { "claims": ["roles"] }`); the authorize path answers
302→sign-in for it (verified 2026-08-24).

## Turn it on

1. Set `OIDC_CLIENT_ID=oiml-rag` + `OIDC_ISSUER=https://id.oimlsmart.org`
   and flip the feature flag. No OP-side act remains.

## The sign-in flow (your half — verify each)

2. The authorize URL carries `scope=openid profile email roles`,
   `state` AND `nonce` (both unguessable, both one-time), PKCE S256.
   (Your state handling is confirmed one-time; add the nonce check if
   absent — the ID token's `nonce` must match what you issued.)
3. The callback validates the ID token against the OP's JWKS — iss
   exact, aud = oiml-rag, exp with ≤ 60 s leeway, the nonce — and the
   JWKS is cached briefly with NO hard-pinned kid (the OP rotates with
   overlap; a pinned kid breaks on rotation day).
4. Map the OP's error taxonomy (`access_denied` and friends) to plain
   language; fail closed, never a stack trace.
5. Your session cookie: `Secure`, `HttpOnly`, `SameSite=Lax` — Strict
   breaks the callback's top-level navigation back from the OP. State
   the lifetime; renew sliding; logout clears it.
6. Logout today is LOCAL-ONLY by necessity: the OP does not yet declare
   `end_session_endpoint` (it lands with the identity-service cutover
   wave — TODO.identity-sso wave A). When the discovery document gains
   it, add the OP-side call so sign-out also ends the OP session (the
   reference implementation in oimlsmart/smart
   `browser/server/auth/oidc.ts` already implements RP-initiated
   logout; copy it).
7. The OP's sign-in page today renders in the platform's shell on the
   identity host (works, and your users see it). After the
   identity-service cutover it becomes the identity-native sign-in page
   — you change NOTHING: the authorize URL is frozen by the OP's
   contract gate.
8. Your edge (Turnstile/WAF/rate limits): the `/auth/login` start and
   `/auth/callback` must not be challenged, or the challenge must
   survive the redirect chain — verify the round-trip under your edge
   rules before announcing.
9. `/auth/me` serves the session's cached claims — the ID token never
   reaches the browser (your HMAC-cookie pattern already does this;
   keep it).

## The claims policy (the joint decision)

10. The token may carry the estate role vocabulary: `applicant`,
    `ia_officer`, `tl_operator`, `biml_officer`, `cs_admin`,
    `mc_member`, `rc_member`, `executive_secretary`, `admin`, `viewer`,
    plus `case_officer`, `certification_officer`, `signatory`,
    `org_admin`.
11. DECIDE NOW: which estate roles map to your member tier — every
    signed-in user, or a bounded set? And which roles map to the
    INTERNAL audience (the ISO corpus)? Once you declare the sets, the
    OP bounds the policy's role allowlist to exactly them (one console
    act — least privilege). Until then the policy is unbounded by
    design; treat an absent/empty roles claim as the anonymous tier,
    honestly.
12. Key your users by `sub` (stable), never by email. Honor
    `email_verified` before any email-keyed behavior. Erasure: a
    deleted account's `sub` stops resolving — treat that as anonymous.
