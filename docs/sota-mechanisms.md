# The SOTA mechanisms — the reference

This is the canonical description of every mechanism in the serving
stack, each with its staircase: what the layer below it cannot do. The
staircase runs from raw text (fewest dimensions) to executable models
(most) — every step adds structure, and every added structure unlocks
questions the previous step could not answer.

## The staircase of representations

```
plain text → clause-anchored documents → typed units (MKO)
           → machine-readable models (Primmel) → execution
```

| Step | Carries | Can answer | Cannot answer |
|---|---|---|---|
| Plain text | words | topical lookup | anything with a citation anchor — half the chunks carry no clause reference at all |
| Clause-anchored prose | words + location | "where does R 60 address creep?" with § | values inside tables, cross-references, anything typed |
| Typed units (MKO) | + tables/formulas/figures as objects, cross-references as links | "which test validates this requirement" (a link, not a sentence); figures | computed conformance |
| Machine models (Primmel) | + constraints, calculations, sequences, terms — machine-checkable | the machine limit itself; test order; instance parameters | executing them in an answer |
| Execution | the check, evaluated | **"is D_max 26 000 v valid for E_max 30 000 v?" → INVALID, computed** | — (the frontier top) |

Measured across the six comparison lanes (witness-graded, 18 rung-tagged
probes): plain 2/18 · adoc 3/18 · MKO 6/18 · Primmel 13/18 · ablation
12/18 · composed 14/18 · full serving 17–18/18.

## The serving mechanisms

### 1. Query understanding (meaning, never strings)
One small model reads every question: language, named publication,
edition, process intent, hypothetical answer, query variants,
decomposition for complex asks, standalone reformulation of follow-ups.
No keyword rules decide anything — the same judgements apply in every
language. *Below this step:* fixed keyword routers, which answer
differently depending on phrasing.

### 2. Hybrid retrieval (dense + lexical, fused)
The question's vector searches the corpus alongside a full-corpus BM25
scan; RRF fusion merges them; a terminology graph adds
concept→document candidates; multiple phrasings and sub-questions run
as parallel lanes; a hypothetical answer serves as an extra search key
(HyDE). *Below:* dense-only retrieval misses exact jargon ("n_LC");
lexical-only misses paraphrase.

### 3. Contextual enrichment (98.7% of non-synthetic chunks)
Every chunk carries a model-written preamble stating where it sits in
its document — written once at index time, its quality persists into
every future retrieval. The preamble lives in the INDEX (plus a 30-day
KV context cache), never in the build artifacts — a full index restore
must replay it from the durable record (`scripts/replay_enrichment.py`,
binding-embed, zero regeneration). Measured the hard way: a restore that
skipped the replay dropped enrichment to 0% and identifier queries
failed first ("what is OIML D 29?" — the preambles carry the
identifier-rich context that ranks them). *Below:* bare chunks retrieve
on local wording.

### 4. Structural retrieval over the clause tree
The corpus IS a tree (clause anchors chain parent→child). A hit's score
blends its ancestors' and descendants' scores — a section whose clauses
are collectively relevant rises; final evidence is presented in
document reading order; same-chain near-duplicates collapse. *Below:*
flat chunk retrieval — no notion of "the section around this clause".

### 5. Section-summary units (multi-granularity)
Depth-1 clause summaries are retrievable objects: a summary that ranks
descends to its quotable child clauses and retires itself — citations
always quote source text. *Below:* one grain per index — either too
coarse to cite or too fine to orient.

### 6. Vocabulary binding (the nomenclature bridge)
Everyday words ("my output keeps drifting") rarely match defined terms
("span stability"). A terminology index of the corpus's defined
concepts links the question to candidate terms (dense candidates +
cross-encoder rerank); the answer model adjudicates and leads with the
corpus's own term, quoting its definition. *Below:* every representation
measured fails the everyday-words→defined-term bridge — the one gap
that is a vocabulary problem, not a structure problem.

### 7. Reranking, edition steering, typed pin
A cross-encoder orders candidates (a stronger model re-orders hard
queries); family-relative steering demotes superseded editions while
keeping them citable when only they carry content — family is the
doctype+number, and the demotion is full-strength under either signal:
the successor edition of the SAME identifier is in the pool, or the
chunk's own status says superseded/unknown against the family's newest
(the corpus carries the supersession the registry's missing successor
links do not; in-force documents are exempt so a newer part-2 never
demotes a current part-1). A document NAMED in the question scopes
retrieval deterministically — read from the question text, never left
to the understanding model's per-call mood ("What is OIML D 29?" was a
coin flip before). Typed objects (tables/formulas/figures) are pinned a
window slot so the answer contract can reference them — and a query
that NAMES the artifact type ("figure", "table", "equation") dominates
unit selection, so the pin lands the object the question is about
(feeding multimodal generation for figures). *Below:* similarity-only
ranking answers from stale editions, guesses at doc scope, and never
surfaces a typed object.

### 8. The answer contract (claims are checkable)
Inline citations on every claim; normative values quoted verbatim from
the cited passage; tables/formulas/figures rendered as typed objects
exactly from the source, never re-typed; a deterministic post-check
enforces all of it (quoted spans must be contained in served passages;
a served table's data must carry its object reference) with one
corrected retry. *Below:* generated prose whose correctness cannot be
measured.

### 9. The verdict engine (conformance by execution)
When a question names a machine-checkable model object, the service
executes it: the question's values bind to the rule's own parameters, a
deterministic evaluator runs the check (OCL boolean expressions,
threshold limits), and the verdict — pass, the standard's own violation
word, or void naming the missing parameters — is attached as data the
model must present faithfully. Counterfactuals are free: hypothetical
values are just values. *Below:* quoting the rule and hoping the reader
does the arithmetic.

### 10. Provable absence
"Does R 60 constrain packaging?" enumerates the standard's entire model
plane and returns a certificate — absent, N nodes enumerated, 0
matches, scope named — never a bare "I found nothing". *Below:* refusal,
which asserts a search, not a proof.

### 11. Answer verification
Any answer can be checked against the corpus: verbatim-quote
containment, object-reference resolution, citation presence
(deterministic) plus a judged faithfulness score (labeled as judged).
*Below:* trust me.

### 12. Multimodal figure interpretation
A pinned figure unit's pixels ride the generation call (R2 asset →
base64 image part), so the model interprets the producer's drawing, not
just its stored caption. Two measured invariants: assets must be
vision-readable — vector-sourced rasters carrying black strokes on
transparent alpha flatten to a solid black rectangle inside vision
pipelines (browsers hid the defect by compositing on white;
`scripts/fix_figure_assets.py` detects and re-uploads white-flattened) —
and images ride their own short trailing user message, because long
passage text + image parts in ONE message triggers nondeterministic
provider 8005s that scale with payload. A third rule guards the blast
radius: pixels attach only when the question WANTS a drawing (names a
figure-ish artifact, or the pinned figure sits in the answering
clause) — and when the multimodal call flakes down to a text-only
fallback, the attach note drops with the pixels (a text model answers
the note, not the question — observed in the wild). *Below:* caption-
only answers that disclaim "the passage does not list" what the drawing
plainly shows.

### 13. Dataset scope and permission gating
Three databases (OIML Publications · OIML SMART Models · ISO/IEC
Conformity Assessment) are selectable per question: the sidebar toggles
persist a scope, every ask carries it, and the server intersects it
with what the SESSION may see — the ISO/IEC corpus requires the estate
permission `ai-preview` (a role code set in id.oimlsmart.org);
membership alone is not the bar, and the UI's lock is cosmetic. A
corpus-scope stage runs last of the pool-assembly stages (after the
lexical union refills the pool post-rerank) so disabling a database
actually disables it at the hit level. *Below:* one monolithic corpus
the user cannot narrow, gated (or not) on login alone.

### 14. The measurement gates
The golden suite (38 cases: doc-level, definitions, table values,
refusals, filters, verdicts, auth, French) runs ×3 against the live
service with witness-span containment grading; the annealment battery
(18 rung-tagged probes) measures capability per representation; EIR
(cited/retrieved) watches window precision; leakage probes gate every
promotion; the deploy pipeline guards branch, tests, version bump and
smoke. Current: golden 37–38/38 (97–100%), annealment 18/18 (mode).

## The vector adapter (one door)

Every chunk crosses one boundary into any index: a pydantic wire schema
(corpus registry, size caps, anchor sanity) and target gating — an
index accepts only the corpora that belong to it. The wire schema
mirrors the serving contract; new producers register corpora in one
place, never ad hoc.

Index equality with the canonical chunk set is an OPERATIONS loop, not
a hope: reconciliation enumerates the index and deletes strays (upserts
never delete — measured 49,553 live vs 31,512 canonical before the
first run); the enrichment replay restores the contexts a full upsert
overwrites; the asset sweep keeps unit images vision-readable. Each
step is a script in `scripts/`, run between surgery and gate.
