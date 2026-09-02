# L5 — CROSS-STANDARD LINKING (P5)

**Definition:** answers that traverse a reference to ANOTHER standard,
returning the linked identity and clause.

**Sub-probes:**
- **a) cites-edge** — *"which ISO/IEC test method does R 60-2 invoke for
  humidity?"* → witness: the ISO/IEC document id + clause from the
  cites edges / references registry. ISOLATION: public lanes assert the
  LINK only — ISO/IEC text never enters a public index; content probes
  are member/internal-only, structurally enforced.
- **b) composition** — *"which CASCO vocabulary governs R 60's
  certification activities, and which aspects of the load cell do its
  requirements bind?"* → `uses: iso-iec-17000` + `iso-iec-17065` + the
  aspects registry (markings, accompanying_document… via
  requirement-binding-targets). Witness: both package ids + ≥1 aspect.

Lane expectations: D strong (composition is a first-class relation);
C partial at (a) (cites edges, no composition); A/B near-zero —
cross-standard vocabulary rarely co-embeds.
