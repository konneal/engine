"""The canonical chunk set is a declared contract (TODO.impl/57).

Run: .venv/bin/python -m pytest tests/python -q

The 2026-09-10 incident: the set lived as four independent enumerations,
one lagged, and reconcile deleted 3,182 served typed-unit chunks as
strays. The set now lives ONLY in ingest.config; this test pins its shape
so editing it is a deliberate, reviewed act — not drift.
"""

from ingest.config import CANONICAL_CHUNK_SOURCES, CHUNKS_JSONL, MODEL_DERIVATIONS

EXPECTED = [
    "chunks.jsonl",
    "model_retrieval_chunks.jsonl",
    "model_typed_chunks.jsonl",
    "mko_chunks.jsonl",  # the deleted-once typed units — never drop again
]


def test_canonical_set_is_exactly_the_served_derivations():
    assert [p.name for p in CANONICAL_CHUNK_SOURCES] == EXPECTED


def test_prose_parse_output_leads_the_union():
    assert CANONICAL_CHUNK_SOURCES[0] == CHUNKS_JSONL
    assert CANONICAL_CHUNK_SOURCES[1:] == MODEL_DERIVATIONS


def test_no_duplicate_paths():
    assert len(CANONICAL_CHUNK_SOURCES) == len({str(p) for p in CANONICAL_CHUNK_SOURCES})
