# API surface spec

The worker's complete HTTP inventory. The API routes are generated from
the OpenAPI document `workers/worker_public/openapi.yaml`
(`scripts/gen-openapi-routes.mjs` → `src/openapi-surface.gen.ts`), and
`index.ts`'s `OPENAPI_HANDLERS` binds every operation to its handler;
`tests/openapi-surface.test.ts` pins the bijection, and the non-API
routes (pages, unit assets, rendered documents) are declared in
`INFRA_ROUTES`. Adding a route = the yaml entry + one handler binding +
regenerate; this document changes with it. Request/response details
beyond the inventory: [API.md](API.md).

## Conventions

- **Dual publication**: `/api/*` is the browser surface (anonymous, or
  member via session cookie / bubble Bearer); `/v1/*` is the integrator
  surface (`Authorization: Bearer oiml_<hex>` API key). Same handler,
  tier derived from the path prefix.
- **Admin routes** authenticate with `Bearer $ADMIN_TOKEN` (a worker
  secret, not an API key).
- Every response is JSON unless noted; errors are
  `{ "error": { "code", "message" } }`. CORS for `*.oimlsmart.org`.
- Trailing slashes are equivalent (segment-exact matching).

## The inventory

| Route | Method | Auth | Handler | Contract |
|---|---|---|---|---|
| `/`, `/api/`, `/index.html` | GET | none | `serveIndexPage` | The SPA shell from the assets binding, `must-revalidate` so deploys can never serve HTML referencing deleted fingerprinted assets. |
| `/auth/login` | GET | none | `handleLogin` | OIDC redirect (PKCE); `?mode=bubble&origin=` starts the embedded-panel flow. |
| `/auth/callback` | GET | none | `handleCallback` | OIDC callback; mints the session cookie; bubble mode postMessages the token to the validated origin. |
| `/auth/me` | GET | session | `handleMe` | `{ authenticated, name, email, roles, tier }`. |
| `/auth/logout` | GET, POST | none | `handleLogout` | Clears the session. |
| `/api/conversations` | GET, POST | session | `conversationsRoute` → `handleConversations` | List / create the signed-in member's conversations. |
| `/api/conversations/:id` | GET, PATCH, DELETE | session (owner) | `conversationsRoute` | One conversation: read / rename / delete. |
| `/api/conversations/:id/messages` | POST | session (owner) | `appendMessageRoute` → `handleAppendMessage` | Append a message turn. |
| `/api/conversations/:id/share` | POST | session (owner) | `shareRoute` → `handleShareConversation` | Publish a conversation to an unlisted share slug. (Was shadowed by the compound conversations branch pre-route-table — the pattern inventory made the collision visible and fixed it.) |
| `/api/shared/:slug` | GET | none | `getSharedRoute` → `handleGetShared` | Read a shared conversation. |
| `/api/projects` | GET, POST | session | `projectsRoute` → `handleProjects` | Contexts (#187): list / create / rename by id / file a conversation by `conversation_id` + `project_id` (null unfiles — membership-as-move). |
| `/api/projects/:id` | DELETE | session (owner) | `projectsRoute` | Delete a context: files detached, conversations returned to the general list. |
| `/api/projects/:id/files` | GET, POST | session (owner) | `projectFilesRoute` → `handleProjectFiles` | List / attach (or replace by id) a context's files; POST names the context by `project_id` in the body. |
| `/api/project-files/:id` | DELETE | session (owner) | `projectFilesRoute` | Detach one file. |
| `/api/datasets` | GET | none (session enriches) | `datasetsRoute` | The corpus catalog + starter questions (the UI's empty state — content from the API, never hardcoded in the client). Session-gated datasets carry `requires` (the estate permission, e.g. `the ai-preview permission (id.oimlsmart.org)`) and `enabled` reflects the permission, not just login. |
| `/api/memories` | GET, POST | session | `memoriesRoute` → `handleMemories` | Personalized memory files (#171): GET list / POST create-or-replace by id (≤10 files × 8k chars) — every query owner-filtered by the session sub. Selected ids ride `/api/ask` as `memories: [id…]` (≤4 per ask, injected as one bounded trusted-user-facts note; the selection salts the answer cache). |
| `/api/memories/:id` | DELETE | session (owner) | `memoriesRoute` | Delete one memory file. |
| `/mcp` | POST | tier | `mcpRoute` → `handleMcp` | The Model Context Protocol server (JSON-RPC 2025-06-18, streamable HTTP); tools: `ask`, `retrieve`. |
| `/health` | GET | none | `healthRoute` | Liveness + deployed `index_version` (the deploy-drift guard reads this). |
| `/api/ask`, `/v1/ask` | POST | tier | `askRoute` → `handleAsk` | The answer contract: streamed or JSON answer, citations, typed blocks, context echo. Quotas per tier. Optional `datasets: [id…]` narrows the corpora searched (server-intersected with session permissions; an explicitly-empty list is a 400); optional `memories: [id…]` selects the member's memory files to inject. Both selections salt the answer cache — a scoped or memory-flavored answer never serves a plain ask. |
| `/api/absence`, `/v1/absence` | POST | tier | `absenceRoute` | Provable absence: exhaustive enumeration over a standard's model plane; `{ verdict: absent \| present, enumerated, matches }`. |
| `/api/verify`, `/v1/verify` | POST | tier | `verifyRoute` | Self-verification battery over a supplied (query, answer): quote anchors, unit references, citations present + judged faithfulness. |
| `/api/lane`, `/v1/lane` | POST | tier | `laneRoute` | Direct retrieval against a comparison index (dense + lexical fused), bypassing the full pipeline — for the annealment matrix and the /compare demo. |
| `/api/search`, `/v1/search` | POST | tier | `searchRoute` → `handleSearch` | Passage search (retrieval without generation). |
| `/api/feedback` | POST | none | `feedbackRoute` | Thumbs up/down keyed by query hash (privacy: hashes only). |
| `/admin/enrich`, `/v1/admin/enrich` | POST | ADMIN_TOKEN | `handleEnrich` | Contextual enrichment / embed+upsert through the vector adapter (the ONLY wire-stage upsert door). |
| `/admin/section`, `/v1/admin/section` | POST | ADMIN_TOKEN | `handleSectionUnit` | Build/serve depth-1 section-summary units. |
| `/admin/vectors` | POST | ADMIN_TOKEN | `handleVectors` | Read/query vectors for ops. |
| `/admin/caption` | POST | ADMIN_TOKEN | `handleCaption` | Figure captioning (vision lane). |
| `/assets/*` | GET | none | `unitAssetRoute` | Immutable unit-keyed figure images (`u:<id>.<ext>`) from R2, 1-year immutable cache. |
| `/api/research`, `/v1/research` | POST | session (member) | `researchRoute` → `handleResearch` | Deep-research dossier loop — members only (research spend stays with humans). |
| `/admin/judge`, `/v1/admin/judge` | POST | ADMIN_TOKEN | `handleJudge` | LLM-as-judge scoring (promotion gates). |
| `/v1/admin/keys` | POST | ADMIN_TOKEN | `handleCreateKey` | Issue an API key (`oiml_<hex>`, shown once). |
| `/v1/admin/keys` | GET | ADMIN_TOKEN | `handleListKeys` | List keys (no secrets). |
| `/v1/admin/keys/:id` | DELETE | ADMIN_TOKEN | `handleRevokeKey` | Revoke a key. |
| `/v1/admin/stats` | GET | ADMIN_TOKEN | `adminStatsRoute` | 7-day telemetry: queries/day/tier, spend by model, feedback, error rate; prunes >90d rows. |
| `/docs/:slug.html`, `/docs/:slug.anchors.json` | GET | public | `docsRoute` | Rendered publication documents (metanorma-mirror layer 1) served from R2 under `docs/`, immutable cache; the anchors map (clause number → heading anchor id) powers citation deep links. Public OIML content only. |
| `/admin/enrich` | POST | ADMIN_TOKEN | `handleEnrich` | modes: default (context+embed+upsert in place), `context` (generate only, KV-cached), `ab` (generate at an explicit effort with NO side effects — the experiment lane; accepts an admin-gated prompt override for judged comparisons). |
| anything else | any | — | — | `404 not_found`; a known path under an undeclared method answers `405 method_not_allowed`. |

## Request semantics worth naming

- **`effort` on ask** (`/api/ask`, `/v1/ask`): `"low"` (default, 1 quota unit) or `"medium"` (member lane, raises reasoning effort AND the output budget — `effortBudget()`; 2 quota units). Effort changes the answer, so it salts both answer caches alongside the datasets/memory selections (`requestEffort`/`answerEffort` in config.ts).
- **`max_iterations` on research**: 1–3, clamped server-side.

## Dispatch semantics

`fetch` = OPTIONS preflight (204) → `matchRoute(ROUTES, method, path)` →
handler with `{ env, req, ctx, url, path, params }` → 405 when the path
is served under another method → 404. `ROUTES` is `INFRA_ROUTES` +
`OPENAPI_SURFACE` (generated from the yaml) mapped through
`OPENAPI_HANDLERS`. Patterns are segment-exact with `:param` capture and
a trailing `*` wildcard (`/assets/*`); entry order is irrelevant because
no pattern overlaps another. The `/api` and `/v1` twins deliberately
share one handler so the tier split can never diverge between the two
publications.

## Isolation invariants (binding lint, `npm run lint:wrangler`)

No route in this worker may reference the internal tier: no ISO index
binding, no internal R2, no internal tokens. Federation happens through
the `INTERNAL_SERVICE` binding inside the ask pipeline only, gated by a
member session. The lint fails CI on any violation.
