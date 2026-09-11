"""The wire projection (vector_adapter.wire_meta): producer jsonl records
are rich derivation artifacts; Vectorize metadata is scalar-or-string[]
law (API error 40017 — the 2026-09-10/11 restore incident where whole
batches were rejected, surfacing as opaque 502s through the binding).

Run: .venv/bin/python -m pytest tests/python -q
"""

from ingest.vector_adapter import wire_meta


def test_scalars_and_none_pass_through():
    md = {"doc_id": "d1", "ordinal": 3, "ok": True, "ratio": 0.5, "status": None}
    assert wire_meta(md) == md


def test_string_arrays_are_legal_and_kept():
    assert wire_meta({"tags": ["a", "b"]}) == {"tags": ["a", "b"]}


def test_nested_objects_dropped_the_incident_shape():
    md = {"doc_id": "d", "table": {"columns": [{"label": "x"}], "rows": ["1|2"]}}
    assert wire_meta(md) == {"doc_id": "d"}


def test_arrays_of_non_strings_and_empty_arrays_dropped():
    assert wire_meta({"nums": [1, 2], "empty": []}) == {}
