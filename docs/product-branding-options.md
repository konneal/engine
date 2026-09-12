# Product and branding options for the standards-intelligence engine

> Status: decision framing (2026-09-12). The question: should the
> multi-SDO RAG/Metanorma/Primmel pipeline come to market as a new
> high-level product, a Metanorma product, or a Primmel product? This
> document gives each route a one-page positioning frame, compares them,
> and states a recommendation with the criteria that would change it.

## The suite frame (applies to every option)

The pipeline has three layers, and the measured staircase prices them:

| Layer | Product role | What it gives the SDO |
|---|---|---|
| Metanorma | Authoring | The document as a model, not a rendering: clause structure, typed units, renderings |
| Primmel | Modeling | The standard as executable rules: constraints, calculations, sequences |
| The engine (this system) | Serving | Cited answers, verdicts, proofs of absence, edition awareness, on the SDO's own domain |

A deployment is white-labeled to the SDO (`ai.<sdo>.org`, their theme,
their identity provider), so the brand decision here concerns the
product the SDO buys — the engine and its integration contract — not the
name their users see. The staircase is the cross-sell narrative: plain
text answers 2 of 18 capability probes, Metanorma-authored content
unlocks typed retrieval, and Primmel models unlock execution.

---

## Option 1 — a new high-level product (recommended)

**Category.** A standards-intelligence platform for standards
organizations: grounded question answering, conformance checking by
execution, and corpus verification over the SDO's own publications.

**Promise.** Your members ask; your standards answer — every claim
cited to the clause, every conformance question decided by executing
your own rules, on your domain, under your brand.

**Buyer.** The SDO secretary general, publication director, or the
owner of the member-services programme. This buyer purchases member
value and organizational authority, not tooling.

**Name candidates** (the decision this document defends is the level,
not the word; candidates for the naming sprint):
- *Anneal* — coined from the project's own methodology (knowledge
  annealment), family-fits Metanorma and Primmel as a coined single
  word, and the methodology is already published in the whitepaper.
  Cost: it needs one sentence of explanation, as Metanorma once did.
- *Verdict* — named for the flagship capability (conformance by
  execution). Strong and concrete; crowded trademark space.
- *Plain descriptive* ("Standards Answers Platform") — fastest to
  understand, weakest to own; workable as the category label whatever
  the brand is named.

Deployment-level naming pattern: `[SDO] Answers`, powered by the
product — mirroring how OIML SMART AI presents today.

**Suite mechanics.** The product consumes Metanorma renderings and
Primmel packages as profile inputs. The measured staircase is the sales
tool: it shows an SDO exactly which capabilities their current content
unlocks and what the next layer buys. Each layer sells the next without
the next being mandatory.

**Go to market.** Direct to SDOs that already author in Metanorma
(shortest path to the full staircase), with OIML SMART AI as the
reference deployment and the whitepaper as the technical proof. The
publisher profile is the integration contract an SDO's team can
evaluate in an afternoon.

**Risks.** A new brand costs market education, and the product must
carry its own demand generation. Mitigated by the reference deployment
and by the suite story, which lets Metanorma's existing SDO
relationships do the introductions without lending the product
Metanorma's name.

---

## Option 2 — a Metanorma family product ("Metanorma Answers")

**Category.** The AI layer of the Metanorma toolchain: answers and
execution over Metanorma-authored corpora.

**Promise.** Standards you author in Metanorma become answerable and
executable, automatically.

**Buyer.** The existing Metanorma buyer: standards editors and
toolchain owners inside SDOs.

**Name.** Rides the family: Metanorma Answers, Metanorma AI.

**Suite mechanics.** Collapses the serving layer into the authoring
brand. The staircase still exists technically but is branded as one
product's capability tiers.

**Advantages.** Fastest to market: the brand exists, the relationships
exist, the story ("author it, then serve it") is one sentence.

**Risks — the reasons this is not the recommendation.**
- It implies the content must be Metanorma-authored, which the engine
  does not require; SDOs with legacy corpora would read themselves out
  of the market.
- It caps the product as a toolchain add-on in the buyer's mind, and
  the buyer is wrong: the person who buys member-facing answers is not
  the person who buys the authoring toolchain.
- It spends Metanorma's brand equity on a service with different
  quality attributes (a wrong answer damages the authoring brand's
  credibility by association).
- It forecloses the Primmel story: execution-the-top-of-the-staircase
  deserves its own co-branding rather than being a feature of the
  authoring tool.

---

## Option 3 — a Primmel family product

**Category.** The serving and execution surface of the Primmel model
world.

**Promise.** Ask your Primmel models anything; the answers are
computed, not retrieved.

**Buyer.** Modelers and the (currently small) Primmel community.

**Risks — disqualifying today.** Primmel is the youngest brand with the
least market recognition; the engine is not about Primmel (retrieval,
enrichment and citation machinery stand entirely apart from the model
plane); and equating the product with executable models under-sells the
90 percent of the system that works on plain corpora. This route
becomes interesting only if Primmel itself becomes the strategic brand
of the estate, which is a larger decision than this one.

---

## Comparison and recommendation

| Criterion | New product | Metanorma sub-brand | Primmel sub-brand |
|---|---|---|---|
| Buyer fit | Secretary/publication director (the one with budget for member value) | Toolchain owner | Modeler |
| Implies Metanorma required | No | Yes | No (implies Primmel) |
| Brand risk to existing products | None | Answers' quality reflects on Metanorma | Ditto |
| Time to market | Slower (new brand) | Fast | Slow |
| Ownable position | The category itself | A feature of a toolchain | A feature of a modeling tool |
| White-label per SDO | Natural | Awkward (whose name does the SDO's user see?) | Awkward |

**Recommendation: Option 1.** The engine is architecturally,
commercially and reputationally a distinct product. Bring it to market
as a new high-level brand, marketed as part of the suite — *authored in
Metanorma, modeled in Primmel, served by [new brand]* — with each
deployment white-labeled to the SDO. Run the naming as its own short
sprint with proper trademark screening; "Anneal" is the internal
candidate with the strongest story.

**What would change this answer:**
- If the go-to-market constraint is the next two quarters and Metanorma
  channel relationships are the only realistic demand source, Option 2
  becomes the pragmatic bridge — ideally as "X, from the makers of
  Metanorma" rather than "Metanorma X", preserving the exit path to a
  standalone brand.
- If the estate decides Primmel is the strategic brand everything else
  rides on, revisit Option 3 — but that is a portfolio-level decision.
