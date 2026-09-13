# Konneal Engine

The publisher-agnostic serving layer for standards intelligence: hybrid
retrieval over clause-structured corpora, citation-grounded answers,
typed tables/formulas/figures, conformance checking by execution, and
the measurement gates that keep it honest. Konneal builds the databases
and serves the API; publishers own their content, profile and frontend.

Architecture and plan: docs/konneal-extraction-plan.md (and
docs/multi-sdo-architecture.md). The reference deployment is OIML SMART
AI (oimlsmart/ai — the reference profile). This repository was born
from it with history preserved (git filter-repo over the engine
subtrees); the README seed commit was replaced by the extraction.
