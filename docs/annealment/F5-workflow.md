# F5 — Certification workflow statefulness

**Powering objects:** `evaluation/processes.yaml` (layer-composed
process tree; `validate_provision` binds the campaign to requirement
URNs like /req/metrological/mpe), `evaluation/gateways.yaml`,
`execution/` (test-report forms, checklist), entities/performance-test-
evaluations, evaluation/sample-selection-rules.

**The win:** the assistant knows WHERE an evaluation stands and WHAT
GATES WHAT — not as prose but as traversable state:
- *"what must be true before the creep test?"* → the sequence rule
  (MDLO baseline first) + the gateway that checks it;
- *"which requirements does this test campaign validate?"* → the
  validate_provision URNs, exhaustively;
- agentic follow-through: checklist items flip state as evidence
  lands; the assistant can say "3 of 62 tests outstanding, blocked on
  the humidity chamber" — a document lane can quote the procedure but
  cannot know the POSITION.

**Why documents can't follow:** procedures in prose are instructions;
here they are a state machine with recorded progress.
