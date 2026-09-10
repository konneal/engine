# metanorma-mirror integration — phase 1: inventory and design

> The goal: answers that open the original document at the clause — a
> citation becomes a door, not a label. This phase inventories what
> exists and designs the integration; implementation is a follow-up.

## 1. What exists today

| Piece | State |
|---|---|
| Clean-corpus sources | `document.xml` (Metanorma XML) per document — the rendering input mirror-js consumes |
| Dirty-corpus sources | Metanorma authoring trees (`metanorma/sections/*.adoc`) — renderable, lower fidelity |
| mirror-js renderer | lives in the smart repo (`browser/src/metanorma-mirror-js.d.ts` + runtime) — client-side XML→DOM rendering |
| R2 public bucket | `rag-public-assets` (unit assets only today) — no document renderings |
| Citation cards | docidentifier + edition + clause + snippet; no in-document link |
| Architecture note | CLAUDE.md already plans "rendered HTML in R2 for clause-anchored deep links (OIML docs only)" |

## 2. The design (three layers, each valuable alone)

1. **Rendered document per publication (build-time).** Render each clean-corpus `document.xml` to a single self-contained HTML (mirror-js headless, or `metanorma build` HTML) with stable clause anchors (`id="cls-4.2.1"`); upload to R2 under `docs/<doc_id>.html`; never the ISO/IEC internal corpus (copyright — public OIML only, same rule as every R2 public object).
2. **Citation deep-links (one-line change once (1) exists).** The citation card's clause becomes `<a href="/docs/<doc_id>.html#<anchor>" target="_blank">` — the worker already emits doc_id + clause_anchor in every citation.
3. **In-context pane (the payoff).** An embedded, scroll-to-clause view inside the answer: clicking a citation opens a slide-over rendering the document AT the anchor with the clause highlighted and its neighbors visible. Load strategy: fetch the R2 HTML and let the browser scroll (`#anchor` + a highlight script), no iframe sandboxing needed if the HTML is same-origin and static.

## 3. Effort and risks

- (1) is a build-script + storage pass over ~36 clean documents; dirty-corpus rendering (880 docs) is a later wave and depends on metanorma build succeeding per tree.
- Clause-anchor stability: the anchors are the corpus's own (`cls-x.y.z`) — the same keys the retrieval index cites, so no mapping layer.
- Payload size: single-file HTML per doc with inlined CSS (~100–500 KB); R2 + CDN caching makes this free at read.
- The figure units interplay: the rendered document embeds its own figures — the pane and the typed-unit blocks will coexist (block = the answer's object; pane = the document's context).

## 4. Follow-up board

- Render + upload the clean corpus (script + R2 layout).
- Citation deep-links in the site.
- The slide-over pane (site component).
- Dirty-corpus rendering pass.
