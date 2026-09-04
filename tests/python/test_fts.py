"""Unit-level language tagging + the typed-table lexical lane (TODO.remaining/09).

Run: .venv/bin/python -m pytest tests/python -q

The invariants under test:
  - tag, never drop: a chunk whose content clearly disagrees with the
    declared document language (the R 79 §3.11 'producto' shape — an
    official bilingual annex inside an EN edition) keeps its row and is
    tagged with the detected language; agreement and inconclusive samples
    keep the declared language.
  - the chunk stopword sets stay in step with the document-level gate
    (ingest/langid.py) — the coupling both modules document.
  - the typed-table lane (artifacts/table_chunks_enrich.jsonl) lands in the
    lexical index with its unit identity (block='table', unit_id) and is
    FTS-retrievable.
  - the whole-edition EN-only exclusion list (issue #72) is honored at the
    load door for EVERY source lane — a lane artifact can predate an
    exclusion (the table artifact carried 6 dirty:r79-2015-spa chunks after
    the edition was excluded).
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from ingest import fts, langid

EN_BODY = (
    "The prepackage shall be marked with the name of the product and the "
    "net quantity. The label shall carry the declaration of the quantity, "
    "and the packer is responsible for the accuracy of the statement. "
    "In the case of products that are sold by weight, the marking shall "
    "indicate that the quantity is expressed in units of mass. "
)

# the R 79 §3.11 shape: Spanish annex content inside an EN-declared edition
ES_ANNEX = (
    "El preenvasado deberá llevar una etiqueta con la denominación del "
    "producto y la cantidad neta. Para los productos que se venden con "
    "una cantidad nominal, el envasador es responsable de la exactitud de "
    "la declaración. Las indicaciones que figuran en la etiqueta deberán "
    "ser claras, y el marcado indicará que la cantidad se expresa con "
    "unidades de masa. "
)

TABLE_TEXT = (
    "Table. Source: OIML R 76 §5.2 Marking requirements. "
    "Columns: Class; Maximum permissible error; Humidity range. "
    "Row: Class = III; Maximum permissible error = ±0.5 e; Humidity range = 30 % to 85 %. "
    "The values in this table are normative for the verification of the instrument."
)

SCHEMA = (
    (Path(fts.__file__).resolve().parents[1] / "workers/worker_public/migrations/0007_chunks_fts.sql").read_text()
    + "\nALTER TABLE chunks ADD COLUMN unit_id TEXT;\nALTER TABLE chunks ADD COLUMN block TEXT;\n"
)


def _rec(cid: str, text: str, **md) -> dict:
    return {"id": cid, "text": text, "metadata": md}


def _base_md(doc_id: str) -> dict:
    return {
        "doc_id": doc_id,
        "docidentifier": "OIML R 76:2006 (E)",
        "doctype": "R",
        "doc_number": "76",
        "edition": "2006",
        "language": "en",
        "corpus": "dirty",
        "tier": "ocr-clean",
    }


@pytest.fixture()
def lanes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    chunks = tmp_path / "chunks.jsonl"
    chunks.write_text("\n".join(
        json.dumps(r)
        for r in [
            _rec("c-en", EN_BODY, **_base_md("dirty:r76-2006-e")),
            _rec("c-es-annex", ES_ANNEX, **_base_md("dirty:r76-2006-e")),
            _rec("c-clean", EN_BODY, **{**_base_md("clean:r076"), "corpus": "clean"}),
            # whole-edition exclusion (on the checked-in list): the lane
            # artifact predates the exclusion — the load door must refuse it
            _rec("c-excluded", ES_ANNEX, **_base_md("dirty:r79-2015-spa")),
        ]
    ) + "\n", encoding="utf-8")
    tables = tmp_path / "table_chunks_enrich.jsonl"
    tables.write_text("\n".join(
        json.dumps(r)
        for r in [
            _rec("t-table", TABLE_TEXT, **{
                **_base_md("dirty:r76-2006-e"), "block": "table", "unit_id": "u:table-3",
            }),
            _rec("t-excluded", TABLE_TEXT, **{
                **_base_md("dirty:r79-2015-spa"), "block": "table", "unit_id": "u:table-9",
            }),
        ]
    ) + "\n", encoding="utf-8")
    missing = tmp_path / "absent.jsonl"
    monkeypatch.setattr(fts, "CHUNKS", chunks)
    monkeypatch.setattr(fts, "TYPED_TABLES", tables)
    monkeypatch.setattr(fts, "MKO_CHUNKS", missing)
    monkeypatch.setattr(fts, "MODEL_CHUNKS", missing)
    monkeypatch.setattr(fts, "CONTEXTS", missing)
    return tmp_path


def _apply(inserts: list[str]) -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.executescript(SCHEMA)
    db.executescript(";\n".join(inserts))
    return db


# ── the stopword-set coupling with the document gate ──────────────────

def test_chunk_stopwords_in_step_with_document_gate():
    assert fts._LANG_MARKERS == langid.STOPWORDS


# ── unit-level tagging: tag, never drop ───────────────────────────────

def test_disagreement_is_tagged_never_dropped(lanes):
    inserts, n, _ = fts.build_rows()
    db = _apply(inserts)
    row = db.execute("SELECT language, text FROM chunks WHERE id = 'c-es-annex'").fetchone()
    assert row is not None, "a bilingual-annex chunk keeps its row — tag, never drop"
    assert row[0] == "es"


def test_agreement_keeps_the_declared_language(lanes):
    inserts, _, _ = fts.build_rows()
    db = _apply(inserts)
    assert db.execute("SELECT language FROM chunks WHERE id = 'c-en'").fetchone()[0] == "en"


def test_inconclusive_sample_keeps_the_declared_language():
    assert fts._detect_language("Maximum permissible error: ±0.5 e.") is None
    assert fts._detect_language("") is None


def test_clean_corpus_rows_are_skipped(lanes):
    inserts, _, _ = fts.build_rows()
    db = _apply(inserts)
    assert db.execute("SELECT COUNT(*) FROM chunks WHERE id = 'c-clean'").fetchone()[0] == 0


# ── the typed-table lane ───────────────────────────────────────────────

def test_table_rows_land_with_unit_identity(lanes):
    inserts, _, _ = fts.build_rows()
    db = _apply(inserts)
    row = db.execute("SELECT block, unit_id FROM chunks WHERE id = 't-table'").fetchone()
    assert row == ("table", "u:table-3")


def test_table_rows_are_lexically_retrievable(lanes):
    inserts, _, _ = fts.build_rows()
    db = _apply(inserts)
    hits = db.execute(
        "SELECT c.id FROM chunks c JOIN chunks_fts f ON c.rowid = f.rowid "
        "WHERE chunks_fts MATCH 'humidity' AND c.block = 'table'"
    ).fetchall()
    assert [h[0] for h in hits] == ["t-table"]


# ── the whole-edition exclusion list binds every source lane ──────────

def test_exclusion_list_binds_the_chunk_lane(lanes):
    inserts, _, _ = fts.build_rows()
    db = _apply(inserts)
    assert db.execute("SELECT COUNT(*) FROM chunks WHERE id = 'c-excluded'").fetchone()[0] == 0


def test_exclusion_list_binds_the_table_lane(lanes):
    inserts, _, _ = fts.build_rows()
    db = _apply(inserts)
    assert db.execute("SELECT COUNT(*) FROM chunks WHERE id = 't-excluded'").fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM chunks WHERE doc_id = 'dirty:r79-2015-spa'").fetchone()[0] == 0
