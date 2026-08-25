# Contributor Audit — 2026-08-25

## Verdict: REJECT the unstaged site/ changes

The contributor's changes convert the Astro site from **static output**
to **SSR on Cloudflare Workers** via `@astrojs/cloudflare`. This breaks
our architecture with zero functional benefit.

### What the contributor did

| File | Change | Intent |
|------|--------|--------|
| `site/astro.config.mjs` | Added `adapter: cloudflare()` | Convert static → SSR |
| `site/package.json` | Added `@astrojs/cloudflare` dep | Enable SSR adapter |
| `site/tsconfig.json` | Added `worker-configuration.d.ts` include | Types for SSR runtime |
| `site/wrangler.jsonc` | NEW — second worker config | Deploy site as separate worker |
| `site/public/.assetsignore` | NEW — exclude `_worker.js` | Framework-fighting artifact |
| `site/public/spinning-globe-3d.js` | DELETED | We replaced with mini (intentional) |

### Why this is wrong

**Our architecture** (documented in CLAUDE.md, docs/ARCHITECTURE.md):
```
Browser → rag-public worker (ai.oimlsmart.org)
    ├── /           → static HTML from ASSETS binding
    ├── /api/*      → handler code
    ├── /v1/*       → handler code
    └── /auth/*     → handler code
```
ONE worker. Static assets served through the worker's `[assets]` binding.
The chat app is a client-side SPA talking to the API via fetch.

**What the contributor's changes would produce:**
```
Browser → which worker? (custom domain conflict)
    ├── oimlsmart-rag-site (SSR worker)
    │     └── / → server-rendered on every request
    └── rag-public (API worker)
          └── /api/* → handler code
```
TWO workers. SSR compute on every page load. Custom domain routing
conflict. Cold starts for a page that was previously instant static HTML.

### Specific violations

1. **Breaks single-worker deployment** — `site/wrangler.jsonc` creates
   a second deployment target (`oimlsmart-rag-site`) that conflicts with
   `workers/worker_public/wrangler.toml` for the custom domain.

2. **SSR is unnecessary** — the site has zero server-side rendering
   needs. It's a chat UI that loads once and talks to the API via
   fetch/SSE. Adding SSR adds compute cost and cold starts with no benefit.

3. **Framework-fighting artifacts** — the `.assetsignore` file exists
   solely to work around the adapter generating `_worker.js` in the
   public directory. This is the framework telling you it doesn't fit.

4. **Incomplete** — `@astrojs/cloudflare` is in package.json but
   package-lock.json wasn't updated (0 new packages found). The
   contributor didn't even install/test their own changes.

5. **Violates CLAUDE.md ecosystem constraints** — "Deployment is purely
   Cloudflare" is about the PLATFORM, not about adding more workers.
   The minimal-infrastructure principle means one worker, not two.

### What to do

Revert all unstaged changes in `site/`:
```bash
git checkout -- site/astro.config.mjs site/package.json site/tsconfig.json
rm site/wrangler.jsonc site/public/.assetsignore
```

If SSR is ever genuinely needed (e.g., for A/B testing, edge-side
personalization, or server components), it should be an explicit
architectural decision with a written proposal — not a drive-by adapter.

---

## Our code — quality audit

### DRY violations (medium priority)

- `json()` and `err()` helpers duplicated in **3 files**: index.ts,
  conversations.ts, share.ts. Extract to `src/lib/http.ts`.

- `Hit` construction (`matches.map((m) => ({ id: m.id, score: m.score,
  metadata: m.metadata, text: ... }))`) duplicated **5 times** in
  pipeline.ts (primary, fallback, RAG-Fusion variants, HyDE, multi-hop).
  Extract to `toHit(m: any): Hit`.

### OCP violations (medium priority)

- **Router**: 16-branch if-chain in a 636-line index.ts. Adding a route
  requires editing the router AND creating a handler — the router should
  be a declarative route table (Map of path patterns to handlers). New
  route = new entry, no router modification.

- **Pipeline**: the `retrieve()` function at 377 lines contains all
  retrieval techniques inline (embedding, vector search, HyDE, multi-query
  fusion, multi-hop decomposition, overview penalty, family boost,
  reranking, keyword ranking, RRF fusion, term boost, language nudge,
  edition boost, diversity). Each new technique modifies the function.
  Should be a composable pipeline: `const hits = pipe(query,
  understanding, [embed, search, hyde, fuseVariants, decompose,
  rerank, hybrid, boost, diversify])`.

### `any` typing (low priority)

Worker code uses `any` for env bindings, AI responses, and metadata.
The Workers AI result shapes are known at each call site. Reduce by
defining interfaces for the response shapes we actually use.

### MECE concerns

- `pipeline.ts` does retrieval + ranking + citation building + message
  building — at least 4 responsibilities. Should be:
  - `retrieval.ts` (embed, search, fuse)
  - `ranking.ts` (rerank, boost, diversify)
  - `citations.ts` (citation building)
  - `messages.ts` (LLM message assembly)

- `ui.ts` at 506 lines duplicates assistant-message rendering between
  `beginAssistantMessage.done()` and `renderConversation` — extract a
  shared `renderAssistantContent(wrap, msg, handlers)`.

### Missing tests

- No worker unit tests (vitest-pool-workers or miniflare). Route
  handlers, retrieval pipeline stages, and auth logic are only tested
  via live e2e. The retrieval pipeline especially would benefit from
  deterministic unit tests (mock the AI bindings, verify ranking logic).

### Recommended cleanup (prioritized)

1. Reject contributor changes (above)
2. Extract `lib/http.ts` (json/err helpers) — 30 minutes
3. Extract `toHit()` helper — 15 minutes
4. Route table replacing if-chain — 1 hour
5. Pipeline middleware chain — 2 hours (careful: must preserve all
   test behavior)
6. Split pipeline.ts into retrieval/ranking/citations/messages — 1 hour
7. Worker unit tests with miniflare — 2 hours
8. Type Workers AI response shapes — 1 hour

Total: ~8 hours of cleanup. Can be done incrementally; each step is
independently valuable.
