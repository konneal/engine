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
  "history": [ {"role":"user","content":"..."}, {"role":"assistant","content":"..."} ]  // last ≤20 turns
}
```

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
object: `{ answer, citations, model, query_hash, follow_ups, similar?, quota?, cached? }`.

### 2.2 Behavior guarantees
- Refusals are never cached or served from the semantic cache
- Conversational/contextual turns are never served from caches
- Edition awareness: when the question names a publication, answers are
  steered to the ACTIVE edition (derived publication registry)
- ISO/IEC corpus: federated for signed-in members only; leakage is
  structurally impossible for anonymous/key tiers

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
| `/api/conversations/{id}` | POST | rename/update |
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
