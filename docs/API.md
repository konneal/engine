# OIML SMART AI — API Reference

*The chatbot API of ai.oimlsmart.org: a conversational contract (ask /
search / sessions / feedback / UI metadata), not a database surface.
Machine access to the publication registry is via the [MCP
server](MCP.md). Authorized users: API keys are issued by the service
operator (see §1.3).*

---

## 1. Authentication & tiers

| Tier | How | Ask quota | Search quota | Model |
|---|---|---|---|---|
| **Anonymous** | none (per-IP) | 20/day | 50/day | cost-first lane |
| **Member** | OIML SMART sign-in (OIDC session cookie) | 300/day | unlimited | member model + ISO/IEC corpus federation |
| **API key** | `Authorization: Bearer <key>` | per-key (default 2000/day) | per-key | as configured |

### 1.1 Anonymous / member
Just call the API — the session cookie (set by `/auth/login`) upgrades
requests automatically. CORS is allowed for `*.oimlsmart.org` origins.

### 1.2 Sign-in flow (members)
- `GET /auth/login` → redirects to id.oimlsmart.org (OIDC, PKCE)
- `GET /auth/callback` → sets the session cookie, returns to the app
- `GET /auth/me` → `{ authenticated, name, email, roles, tier }`
- `GET|POST /auth/logout` → clears the session

### 1.3 API keys (integrators)
Keys are `oiml_<hex>`, shown once at creation. Operator issues them:

```
curl -X POST https://ai.oimlsmart.org/v1/admin/keys \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name": "partner-integration", "day_limit": 5000}'
```
Response includes the plaintext `key` — store it now. List/revoke via
`GET /v1/admin/keys` (revocation is a D1 update).

### 1.4 The bubble bridge (the assistant embedded in estate properties)

The shared chrome's assistant panel (site-shell's `AiBubble`) runs on
OTHER origins (the platform, www, the minisites). The session cookie
never crosses origins (`SameSite=Lax`, and the estate bans shared-domain
cookies — the identity guide's SSO doctrine), so the panel carries the
session as a Bearer token instead:

- `GET /auth/login?mode=bubble&origin=<the page's origin>` — the panel
  opens this in a popup. The origin is validated at flow start
  (`https://oimlsmart.org`, `https://*.oimlsmart.org`, or
  `http://localhost[:port]` for dev) and bound to the OIDC state.
- `GET /auth/callback` — on a bubble flow, sets the cookie as usual AND
  renders a confirm page ("Continue as <name> to <host>?"); only the
  user's explicit click postMessages `{ type: "oimlsmart-ai-session",
  token, name, expiresAt }` to the validated origin (never `*`).
- The token is the same HMAC-signed payload the cookie carries (7-day
  TTL). The panel sends it as `Authorization: Bearer <token>`; every
  session-gated route (`/auth/me`, `/api/conversations*`,
  `/api/ask|search` member tier) accepts either form. Stateless — there
  is no server-side revocation; sign-out is the panel discarding the
  token.

## 2. Asking questions

### 2.1 `POST /api/ask` (browser) · `POST /v1/ask` (integrators)

Request:
```jsonc
{
  "query":  "What is the maximum permissible error for class III?",  // required, ≤8000 chars
  "lang":   "fr",            // optional 2-letter hint; answers follow the question's language
  "stream": true,            // SSE (default for /api/ask); false → single JSON
  "fresh":  false,           // true skips the answer cache (regenerate)
  "prev":   "previous user question",          // optional, helps follow-up retrieval
  "history": [ {"role":"user","content":"..."}, {"role":"assistant","content":"..."} ],  // last ≤20 turns
  "context": {                          // optional, the declared context (see §2.1.1)
    "kind":  "entity",                  // "page" | "entity" | "document" (absent = none)
    "label": "this certificate R60/2021-A-EX1-26.01",   // ≤120 chars, echoed for display
    "route": "/app/standards/r60/certificates/…",       // optional, page/entity
    "doc":   "urn:oiml:pub:r:60-1:2021",                // optional, entity/document: scopes retrieval
    "edition": "2021"                   // optional 4-digit override
  }
}
```

#### 2.1.1 The declared context (the panel's opt-in chips)

The estate's assistant panel (site-shell's `AiBubble`) lets the user pin a
context per message — the page they're on, the entity the page carries, or
a corpus document. The service applies it honestly:

- `doc` accepts the URN provenance form (`urn:oiml:pub:r:60-1:2021`) or the
  plain docidentifier (`OIML R 60-1:2021` / `R 60`). A resolvable document
  scopes retrieval to the publication FAMILY (the same filter a named
  document in the query gets — an entity's clause provenance spans parts).
  The family must exist in the publications registry, else the answer runs
  on the general corpus and says so.
- A DECLARED scope is a hard seal: the pipeline's soft-steer widenings (the
  sparse-filter union, the lexical union, the sub-query lanes) are cut back
  to the family before generation, because the panel's context line claims
  the grounding — a citation from outside the declared publication would
  make it a lie. (A document named in the question keeps the soft steer —
  the widen covers sparse publications there.) If nothing survives the
  seal, the answer refuses honestly within the scope.
- A document named **in the question** always wins over the declared chip —
  the context informs, never overrides the user's explicit words. "Named" is
  read from the question's own text (a letter+number mention like "R 76"),
  never from the understanding stage's inference alone: a topic-prior
  extraction is not the user's words and never steals the chip, and a naming
  the text plainly carries wins even when the extraction misses it.
- The entity's own data is NOT in scope (the "my account" chip's live-data
  delegation, §2.1.2, is the record-level ground); the grounding is the
  governing publication's clauses.
- A declared context bypasses both answer caches (the answer depends on the
  declaration, not just the query) and is never written into them.
- Conversational turns (greetings, identity) never ground in a declared
  context — the echo reports `none`.

Every ask response — the SSE `citations`/`done` events and the JSON body —
echoes what was APPLIED, so the panel's context line never invents a
grounding:

```jsonc
"context_applied": {
  "kind": "entity",                       // the declared kind, or "none"
  "label": "this certificate R60/2021-A-EX1-26.01",
  "scoped_to": "OIML R 60:2021",          // null when the declaration did not scope retrieval
  "note": "question-document-wins"        // only when a doc-carrying declaration
}                                         // did not scope: also "document-not-in-corpus"
```

#### 2.1.2 The "my account" context (TODO.ai-platform/03 — members only)

The panel's fourth chip opts the message into the user's OWN live platform
data — "my account — reads what you can see". The service reads the platform
EXACTLY as the user, never wider:

- The sign-in retains the OP's access token for the session's exchange
  window only (KV keyed by the session token's hash, TTL = the OP token's
  own expiry — never the database, never past the window; sign-out drops
  it deliberately).
- Each live ask exchanges it at the OP (the RFC 8693 session delegation —
  the identity service's RP guide §9b) for a token scoped
  `<platform>:read`, the account's standing re-judged AT the exchange (a
  role lost mid-session narrows the next answer honestly).
- The platform reads ride that token; the platform enforces the cones
  exactly as for the user's own browser. The records the answer grounds in
  map 1:1 from the platform's responses — the service can never invent or
  widen one. Org administrators see the exchange + the reads on the audit
  chain (the actor claim names this service), never the conversation.
- Conversational turns never read the account (a greeting grounds in
  nothing); an account ask whose corpus retrieval is empty still answers
  from the records.

The response gains `records` (each `{ store, id, label, url, status?, date?,
detail? }` — the panel renders the links; the claims about a record name it)
and the echo carries the live read:

```jsonc
"context_applied": {
  "kind": "account",
  "label": "my account",
  "scoped_to": null,                      // the account context never scopes the corpus
  "live": { "read_at": "2026-08-31T09:00:00Z", "stores": ["applications"], "records": 3 }
}
```

When the live read cannot honestly happen the answer runs on the corpus and
the echo says why: `"note": "sign-in-required"` (no member session),
`"live-window-expired"` (the sign-in's window lapsed — sign in again to
refresh), `"live-unavailable"` (the exchange refused or the platform was
unreachable). Never a silent widening, never an invented record.

The deployment wiring: `SMART_PLATFORM_API` (the platform's API base) +
`SMART_PLATFORM_CLIENT_ID` (its client id at the OP — the delegation's
scope target). Absent, the chip's ask answers `live-unavailable` honestly.

#### 2.1.3 The draft acts (TODO.ai-platform/04 — act with confirmation)

The assistant can PREPARE an act; the user commits it in the platform's
real UI. **The service never writes**: the only credential in play is the
read-scoped delegation (§2.1.2's exchange), and it feeds nothing but the
role check. The pilot act is the **application prefill**
(`application_prefill`); the TL dispatch, the review comment and the
evaluation summary are named follow-ups on the same contract.

A draft ask (the user names the act — "draft / prepare / start / submit an
R 60 application…") bypasses both answer caches and answers with:

- `answer` — a deterministic account of what was drafted, what was
  dropped and why, and the boundary: the draft opens in the real form
  with every field editable, and only the user's own click commits it
  (the service never claims a performed act).
- `draft` — the wire shape below (ABSENT on a refusal).
- `citations` — the resolved Recommendation the act anchors on.

```jsonc
"draft": {
  "kind": "draft",
  "act": "application_prefill",
  "version": 1,
  "title": "New OIML R 60:2021 application",
  "prepared_at": "2026-08-31T10:00:00Z",
  "requires_confirmation": true,          // ALWAYS — the draft is an input, never a channel
  "fields": {
    "standard_doc": "urn:oiml:pub:r:60:2021",   // the estate URN, resolved against the corpus registry
    "standard_label": "OIML R 60:2021",
    "family_designation": "LC series",          // only fields the user stated
    "model_designation": "LC-500",
    "description": "…",
    "samples": [{ "serial": "SN-0042", "condition": "NEW" }],
    "scheme": "A"                                // or "B"
  },
  "dropped": [                                 // the never-invents account
    { "field": "family_designation", "value": "Phantom-9", "reason": "not stated in your own words" }
  ],
  "notes": ["The technical parameters stay with you: the form derives what the model declares…"]
}
```

The honest rules, all eval-gated (the golden suite's `draft-*` legs):

- **Never-invents**: the extraction (an LLM pass) only PROPOSES fields;
  every drafted value must trace — through its own source span — to the
  user's own messages, or it lands in `dropped` and the answer names it.
  The instrument model's derivations never ride the draft: the platform's
  form derives them on open, the user confirms each one.
- **The refusals speak the platform's role vocabulary** (read from the
  exchanged token's `service_roles`, re-judged live at the exchange):
  the anonymous visitor is asked to sign in; a role that cannot perform
  the act (the test-lab operator, the issuing-authority officer, the
  read-only viewer) is told what the account IS and that the act belongs
  to the applicant — no draft. Fail-closed: a role the pilot does not
  recognize refuses. An unresolvable Recommendation (never named by the
  user, or not in the corpus) refuses — the act anchors on a real
  document.
- **The never-writes must-not**: a crafted prompt ("submit it now with
  my token") yields at most a draft with `requires_confirmation: true` —
  the response NEVER carries a performed-act marker. The platform's
  bearer cone refuses the delegated write class outright either way;
  the commit path is the platform's own form, its own validation, its
  own audit (which marks the act AI-prepared).

**SSE**: the `draft` rides the first (`citations`) frame beside
`context_applied`; `token` frames carry the answer; `done` as usual.
The draft is ephemeral — the conversations API never persists it (a
resumed session keeps the honest context line, not a stale draft).

#### 2.1.4 The model plane (TODO.ai-platform/05 — model-native grounding)

The assistant grounds in the SMART Recommendation MODELS, not only the
prose corpus. The packages' machine content — the requirements'
constraints (the machine limits the platform's verdict engine evaluates),
the applicability rules, the acceptance criteria, the conformance tests,
the term definitions — indexes **alongside** the prose (Vectorize corpus
`smart-model` + the D1 `model_nodes` store + the FTS lane). The index
DERIVES from the primmel packages, the models' single source of truth:
the smart repo's `derive-model-plane.ts` projects the packages into
committed bundles (`browser/public/data/model-plane/*.json`, byte-clean-
guarded by its SSOT gate) and `python -m ingest.cli model-plane` consumes
them from the sibling smart checkout (`SMART_REPO`). **The freshness is
gated**: every bundle carries the package's `source_hash`; the committed
pins (`ingest/model_plane_pins.json`) record what the index derived from,
and `python -m ingest.cli model-plane --check` (CI: the ingest job) fails
when a package moved — a package change re-indexes.

**The model-aware chips.** "This requirement" on a model surface (the
platform's requirement / conformance-test / term pages) declares an
entity context whose label leads with the canonical node id
(`/req/metrological/mpe — Maximum permissible errors…`). The service
binds the node EXACTLY (the strict id grammar — never a fuzzy match):
the declared label's id wins, then a node id the question names; the
standard comes from the declared or question-named publication only (an
LLM inference never narrows the bind), and a scope-less id binds only
when unambiguous across the indexed standards — an ambiguous or
unindexed id binds NOTHING, honestly. A bound node grounds the answer in
the node itself: its constraint (quoted verbatim), its applicability,
its acceptance, its provenance, its tests/preconditions ride the prompt
as a structured block, the citations lead with the model node
(`corpus: "smart-model"`), and the echo names the grounding:

```jsonc
"context_applied": {
  "kind": "entity",
  "label": "this requirement /req/metrological/mpe — Maximum permissible errors on type evaluation",
  "scoped_to": "OIML R 60:2021",
  "model": {
    "node_id": "/req/metrological/mpe",
    "kind": "requirement",
    "standard": "oiml-r60",
    "clause": "urn:oiml:pub:r:60-1:2021#clause-5.3.2"
  }
}
```

**The explained verdict.** The applicability/evaluation engines' verdicts
answer in plain language with the constraint + the clause + the user's
value ("your class C instrument fails 5.3.2 because the MPE for class C is
±…, your declared value is …"). The verdict EXPLANATION is the platform's
computation — the engine's own trace seam (the smart repo's
`engine/verdict-explanation.ts`, proven on its golden cases), never a
constraint this service invents or recomputes. The model plane grounds
the static half (the requirement's machine limit + its clause + its
acceptance); a live verdict's trace is the platform's own computation.

**The honesty (the clause-drift doctrine's posture).** Where the model
and the prose disagree, the answer says so and cites both: a model node
that DECLARES a source discrepancy (the packages' `source_discrepancy`
annotation — e.g. R 60-1, 5.6.3.1's C_Hmax ≤ 1 v vs R 60-3, 2.1.7's
C_Hmax ≤ MPE) carries it into the grounding block verbatim and the answer
must surface it; and every retrieved model-plane passage rides the corpus
note — where a model passage and a prose passage disagree (a different
edition's prose included), say so explicitly and cite both.

The eval legs (the golden suite's `model-*` cases): the explained-
verdict shape (the machine limit + the clause + the value in the answer),
the model-aware chip binding (the echo above), the disagreement posture,
and the must-not (an unbindable declaration carries NO model echo —
never an invented grounding).

**SSE protocol** (`text/event-stream`, each line `data: {json}`):
1. `{"type":"citations","citations":[...],"quota":{"used":n,"limit":m}}` — arrives FIRST so chips render while the answer streams
2. `{"type":"token","v":"…"}` — repeated, in order
3. `{"type":"done","model":"…","query_hash":"…","follow_ups":["…","…"],"similar":false}`

`similar: true` means the answer came from the semantic cache (a
near-identical recent question). `follow_ups` are suggested next
questions (present when understanding produced them).

**Citation object** (also the shape in the `done`/JSON responses):
```jsonc
{
  "doc_id": "clean:r060/1", "docidentifier": "OIML R 60-1",
  "edition": "2021", "clause_anchor": "4.1.2", "clause_title": "…",
  "snippet": "…", "status": "in-force",           // or superseded/withdrawn
  "superseded_by": "OIML R 60-1:2021",            // when applicable
  "url": "https://…"                               // deep link to the rendering when available
}
```

**Answer conventions:**
- Claims cite inline as `[OIML R 60-1:2021 §4.1.2]`
- Normative values carry quote anchors: `[OIML R 76:2004 §3.2: "the maximum permissible error shall not exceed 0.5e"]` — the quoted phrase is verbatim from the cited passage (mechanically checkable)
- Out-of-corpus questions return exactly: `I don't have information on this in the indexed OIML publications.` followed by a short redirect
- Conversational turns (greetings, identity, capability) are answered directly without citations; off-topic SUBJECT questions are still treated as knowledge questions

**Non-stream response** (`stream:false`): the same fields as one JSON
object: `{ answer, citations, model, query_hash, follow_ups, similar?, quota?, cached? }`
plus `context`: the passages the answer was actually built from
(`[{doc_id, clause_anchor, text}]`, response-only, never cached) — grounding
transparency for integrators and the eval battery.

### 2.2 Behavior guarantees
- Refusals are never cached or served from the semantic cache
- Conversational/contextual turns are never served from caches
- Edition awareness: when the question names a publication, answers are
  steered to the ACTIVE edition (derived publication registry)
- ISO/IEC corpus: federated for signed-in members only; leakage is
  structurally impossible for anonymous/key tiers

### 2.3 `POST /api/research` (members only)
```jsonc
{ "query": "trace the creep and return requirements across R 60-1 and R 76-1", "max_iterations": 3 }
```
Bounded agentic loop (≤3 retrieve→judge→refine iterations) over the same gated retrieval; returns `{ answer, citations, model, blocks?, research: { iterations, passages, elapsed_ms } }`. Not streamed; expect up to ~90s.

**Blocks (answer contract v2):** answers may reference typed MKO units as `[[u:<id>]]` tokens inside `text`; the response carries `blocks: [{ unit_id, type: table|formula|figure|term, docidentifier, edition?, payload }]` — producer-validated payloads (MN 116), never model-retyped data. Invalid references are dropped server-side before rendering.

## 3. Retrieval-only

### `POST /api/search` · `POST /v1/search`
```jsonc
{ "query": "maximum permissible error", "top_k": 5 }   // top_k ≤ 10
```
Response:
```jsonc
{ "results": [ { "doc_id","docidentifier","edition","language",
                 "clause_anchor","clause_title","status","superseded_by",
                 "text","score" } ],
  "filters": { …applied metadata filters… }, "quota": { … } }
```
No generation cost — embedding + hybrid retrieval only.

## 4. UI metadata

### `GET /api/datasets`
```jsonc
{ "datasets": [ { "id","label","description","enabled",
                  "requires": "an OIML SMART account" } ],   // locked corpora
  "suggestions": ["What is R 60?", …] }                       // starter questions
```

## 5. Conversations (members)

| Route | Method | Purpose |
|---|---|---|
| `/api/conversations` | GET | list synced conversations |
| `/api/conversations` | POST | create |
| `/api/conversations/{id}` | GET | one conversation |
| `/api/conversations/{id}` | PATCH | rename |
| `/api/conversations/{id}` | DELETE | remove |
| `/api/conversations/{id}/messages` | POST | append a message |

### Sharing (members)
- `POST /api/conversations/{id}/share` → `{ "url": "https://…/s/<slug>" }` (10 shares/day)
- `GET /api/shared/{slug}` → read-only rendered conversation (public link)

## 6. Feedback

`POST /api/feedback` `{ "query_hash": "<64-hex>", "rating": 1 | -1 }` —
thumbs up/down on an answer; logged to D1 for eval.

## 7. Operations (operator token)

| Route | Purpose |
|---|---|
| `GET /health` | liveness + index version |
| `POST /v1/admin/keys` / `GET` | API key issue/list |
| `GET /v1/admin/stats` | 7-day query/spend by model, feedback ratios |
| `POST /admin/enrich` | contextual-enrichment batches (Bearer ADMIN_TOKEN; internal) |
| `POST /admin/judge` | RAGAS-style scoring (question/answer/passages; internal eval) |

## 8. Errors

| HTTP | code | meaning |
|---|---|---|
| 400 | `invalid_input` | bad query/shape |
| 401 | `unauthorized` | bad key / no session where required |
| 429 | `quota_exceeded` | daily limit reached |
| 503 | `generation_disabled` / `retrieval_unavailable` | kill switch / transient — retry |
| 502 | `generation_failed` | model unavailable — retry |

## 9. Minimal client

```bash
curl -N https://ai.oimlsmart.org/v1/ask \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"query":"What is OIML R 60?","stream":true}'
```
```js
const res = await fetch("/api/ask", {method:"POST",
  headers:{"content-type":"application/json"},
  body: JSON.stringify({query, stream:true})});
for await (const chunk of res.body) { /* parse data: lines */ }
```
