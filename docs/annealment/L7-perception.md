# L7 — MULTIMODAL PERCEPTION (P7)

**Definition:** answers whose evidence is in PIXELS, not text.

**Sub-probes:**
- **a) caption/asset** — *"what does the R 60-2 test setup figure
  show?"* → figure unit + stored caption/vision description.
- **b) pixel-only content** — *"what are the three labeled cases in the
  design-shapes example?"* → labels A/B/C that exist ONLY in the
  drawing; witness: the label values (verified: the deployed system
  reads them from pixels — attachFigureImages).
- **c) user-image grounding** — a nameplate photo → "which accuracy
  class marking does this carry / which OIML R applies?" (image
  questions, shipped). Witness: classification.

Lane expectations: C strong a–c (figure lane live + multimodal
generation); D partial (references figures in sequences —
`fig-2/fig-3` — asset binding pending); A/B zero (no units, no assets).
The most DEMO-VISIBLE separator: same question, lane C shows the image
and reads it, lane A shows prose soup.
