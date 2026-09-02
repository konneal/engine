# L6 — DIACHRONY / EDITIONS (P6)

**Definition:** answers that depend on WHICH edition, or on WHAT
CHANGED between editions.

**Sub-probes:**
- **a) current-edition selection** — *"which R 60 edition applies to a
  type evaluation started this year?"* → 2021 (lifecycle: status
  current, supersedes 2017). Witness: edition + status.
- **b) delta extraction** — *"what changed in the creep requirements
  between 2017 and 2021?"* → D computes the diff between EDITION
  PACKAGES (editions/2017/*.prl vs current) at the model level — the
  witness is the delta fact (constraint added/changed, limits moved).
  C can align units by hash but has no semantic diff (metanorma-document
  #53 item 5). A/B near-zero.
- **c) temporal jurisdiction** — *"which edition governed an evaluation
  performed in 2019, and under what validity rule?"* → 2017 (validity
  windows: 2017 until 2021-01-01). Only D (validity.from on editions).

Lane expectations: D strong a–c; C partial (a, steering already ships);
A/B fail b/c. Deepened by frontier F7.
