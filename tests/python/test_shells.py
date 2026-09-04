"""The empty-shell filter in the data-quality report (TODO.remaining/09 item 3).

Run: .venv/bin/python -m pytest tests/python -q

OCR corpses (<100 words, mostly failed non-Latin OCR) are flagged
tier='shell' at parse, excluded from the indexable set, and NAMED in the
build's data-quality report (artifacts/report.json) — the report is the
evidence at each reload that the corpses stayed out.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from ingest import cli, parse

EN_BODY = (
    "The instrument shall carry a marking with the name of the manufacturer "
    "and the pattern approval sign. The verification of the instrument "
    "includes a visual examination and the performance tests described in "
    "the annex, and the maximum permissible errors apply to each test. "
)

SHELL_BODY = "OCR failed on this scan — only fragments survived."


def _write_dirty_doc(root: Path, slug: str, body: str) -> None:
    meta = root / slug / "metanorma"
    meta.mkdir(parents=True)
    (meta / "document.adoc").write_text(
        f"= Test {slug}\n:docidentifier: OIML R 99:2020 (E)\n:language: en\n:edition: 2020\n\n== Scope\n\n{body}\n",
        encoding="utf-8",
    )


@pytest.fixture()
def built(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict:
    corpus = tmp_path / "corpus"
    _write_dirty_doc(corpus, "r99-2020-e", EN_BODY * 3)
    _write_dirty_doc(corpus, "r98-2019-e", SHELL_BODY)
    artifacts = tmp_path / "artifacts"
    monkeypatch.setattr(parse, "DIRTY_DIR", corpus)
    monkeypatch.setattr(cli, "ARTIFACTS", artifacts)
    monkeypatch.setattr(cli, "CHUNKS_PATH", artifacts / "chunks.jsonl")
    monkeypatch.setattr(cli, "MANIFEST_PATH", artifacts / "manifest.json")
    cli.build("dirty", None)
    return {
        "report": json.loads((artifacts / "report.json").read_text(encoding="utf-8")),
        "manifest": json.loads((artifacts / "manifest.json").read_text(encoding="utf-8")),
        "chunks": [json.loads(l) for l in (artifacts / "chunks.jsonl").open(encoding="utf-8")],
    }


def test_shell_is_flagged_in_the_data_quality_report(built):
    assert built["report"]["shells"] == ["dirty:r98-2019-e"]


def test_shell_reaches_no_manifest_entry(built):
    assert [m["doc_id"] for m in built["manifest"]] == ["dirty:r99-2020-e"]


def test_shell_contributes_no_chunks(built):
    assert built["chunks"], "the healthy doc still chunks"
    assert all(c["doc_id"] != "dirty:r98-2019-e" for c in built["chunks"])
