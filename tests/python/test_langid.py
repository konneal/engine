"""Document-level language verification + the exclusion list (issue #72).

Run: .venv/bin/python -m pytest tests/python -q

The invariants under test are the EN-only directive's (2026-08-24):
  - CONTENT decides: an EN-declared edition whose body is Spanish is
    detected and excluded whole (the R 79:2015 ES defect), with evidence.
  - Exclusion is whole-edition, never per-chunk: an EN edition with an
    official French annex is English and stays.
  - Inconclusive samples (short, table-heavy) never override metadata.
  - The checked-in exclusion list loads, matches by ingest identity, and
    wins over an inconclusive sample.
"""
from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from ingest.langid import (
    EXCLUSIONS_PATH,
    CorpusExclusion,
    check_doc_language,
    detect_document_language,
    load_exclusions,
    normalize_language,
)
from ingest.models import DocRecord, Section

EN_BODY = (
    "The prepackage shall be marked with the name of the product and the "
    "net quantity. The label shall carry the declaration of the quantity, "
    "and the packer is responsible for the accuracy of the statement. "
    "In the case of products that are sold by weight, the marking shall "
    "indicate that the quantity is expressed in units of mass. "
) * 40

ES_BODY = (
    "El preenvasado deberá llevar una etiqueta con la denominación del "
    "producto y la cantidad neta. Para los productos que se venden con "
    "una cantidad nominal, el envasador es responsable de la exactitud de "
    "la declaración. Las indicaciones que figuran en la etiqueta deberán "
    "ser claras, y el marcado indicará que la cantidad se expresa con "
    "unidades de masa para cada una de las presentaciones. "
) * 40

FR_ANNEX = (
    "Instrument de pesage — termes et définitions. Le récepteur de charge "
    "et le dispositif indicateur sont des éléments de l'instrument. "
) * 12

CYRILLIC_BODY = (
    "Міжнародна рекомендація встановлює метрологічні вимоги до засобів "
    "вимірювальної техніки та порядок їх застосування під час повірки. "
) * 30

SHORT_BODY = "Maximum permissible error: ±0.5 e. See Table 1."


def doc(text: str, *, slug: str = "r99-2020-e", corpus: str = "dirty", language: str = "en") -> DocRecord:
    return DocRecord(
        doc_id=f"{corpus}:{slug}",
        slug=slug,
        corpus=corpus,
        tier="ocr-clean",
        docidentifier="OIML R 99:2020 (E)",
        doctype="R",
        doc_number="99",
        edition="2020",
        language=language,
        title="Test publication",
        sections=[Section(anchor="1", title="Scope", text=text)],
    )


# ── detection ────────────────────────────────────────────────────────

def test_english_body_detects_en():
    det = detect_document_language(EN_BODY)
    assert det.detected == "en"
    assert det.scores["en"] > det.scores["fr"] + det.scores["es"]


def test_spanish_body_detects_es():
    # the R 79:2015 (ES) shape: 'el/la/de/que' dominate the sample
    det = detect_document_language(ES_BODY)
    assert det.detected == "es"
    assert det.scores["es"] > 2 * det.scores["en"]


def test_bilingual_annex_stays_en():
    # EN edition with an official FR terminology annex (R 76:2006 shape):
    # the annex never outweighs the body — whole-edition verdict is EN
    det = detect_document_language(EN_BODY + "\n\n" + FR_ANNEX)
    assert det.detected == "en"


def test_short_or_table_heavy_is_inconclusive():
    det = detect_document_language(SHORT_BODY)
    assert det.detected is None


def test_non_latin_body_detects_non_latin():
    det = detect_document_language(CYRILLIC_BODY)
    assert det.detected == "non-latin"
    assert det.nonlatin_share > 0.3


# ── the per-document gate ────────────────────────────────────────────

def test_en_declared_es_content_is_excluded_with_evidence():
    check = check_doc_language(doc(ES_BODY), [])
    assert check.excluded is True
    assert check.detected == "es"
    assert check.declared == "en"
    assert check.listed is False
    assert "es=" in check.evidence and "en=" in check.evidence


def test_en_content_is_kept():
    check = check_doc_language(doc(EN_BODY), [])
    assert check.excluded is False
    assert check.detected == "en"


def test_inconclusive_keeps_declared_language():
    check = check_doc_language(doc(SHORT_BODY), [])
    assert check.excluded is False
    assert check.detected is None


def test_listed_exclusion_wins_over_an_inconclusive_sample():
    # the audited decision stands even when the sample is too thin to judge
    entry = CorpusExclusion(
        doc_id="dirty:r99-2020-e",
        docidentifier="OIML R 99:2020 (E)",
        edition="2020",
        detected_language="es",
        evidence="operator-confirmed Spanish edition",
        detected_on="2026-08-31",
    )
    check = check_doc_language(doc(SHORT_BODY), [entry])
    assert check.excluded is True
    assert check.listed is True
    assert check.detected == "es"


def test_exclusion_list_matches_by_ingest_identity_only():
    # a different edition of the same publication is NOT caught — the
    # R 79:2015 ES entry must never exclude the legitimate EN editions
    entry = CorpusExclusion(doc_id="dirty:r79-2015-spa", detected_language="es")
    check = check_doc_language(doc(EN_BODY, slug="r79-1997-e"), [entry])
    assert check.excluded is False


def test_declared_non_en_is_the_declared_gates_call():
    # declared-fr content-fr is excluded by the declared-language filter;
    # verification stays out of it (it speaks for EN-index candidates)
    check = check_doc_language(doc(FR_ANNEX * 4, language="fr"), [])
    assert check.excluded is False


def test_listed_entry_fires_even_when_declared_non_en():
    # the R 79:2015 (ES) shape once the slug suffix declares 'es': the
    # declared gate would exclude it anyway, but the checked-in entry must
    # still fire so the audit report names every listed exclusion met
    entry = CorpusExclusion(doc_id="dirty:r79-2015-spa", detected_language="es",
                            evidence="whole edition is the Spanish text", detected_on="2026-08-31")
    check = check_doc_language(doc(ES_BODY, slug="r79-2015-spa", language="es"), [entry])
    assert check.excluded is True
    assert check.listed is True


def test_three_letter_declared_codes_normalize():
    # producer metadata (the MKO lane) can carry ISO 639-2 forms
    assert normalize_language("eng") == "en"
    assert normalize_language("spa") == "es"
    assert normalize_language("") == "en"
    check = check_doc_language(doc(ES_BODY, language="eng"), [])
    assert check.declared == "en"
    assert check.excluded is True


# ── the checked-in list ──────────────────────────────────────────────

def test_load_exclusions_missing_file_is_empty(tmp_path: Path):
    assert load_exclusions(tmp_path / "nope.yaml") == []


def test_load_exclusions_round_trip(tmp_path: Path):
    path = tmp_path / "corpus-exclusions.yaml"
    path.write_text(textwrap.dedent("""\
        exclusions:
          - doc_id: "dirty:r79-2015-spa"
            docidentifier: "OIML R 79:2015 (E)"
            edition: "2015"
            declared_language: en
            detected_language: es
            evidence: "stopword hits over 3493 sampled words: es=787, fr=339, en=36"
            detected_on: "2026-08-31"
            reference: "oimlsmart/rag#72"
    """), encoding="utf-8")
    entries = load_exclusions(path)
    assert len(entries) == 1
    e = entries[0]
    assert e.doc_id == "dirty:r79-2015-spa"
    assert e.detected_language == "es"
    assert e.edition == "2015"


def test_checked_in_list_loads_and_carries_r79_2015_es():
    # the repo's own artifact: R 79:2015 (ES) is the first entry (issue #72)
    entries = load_exclusions(EXCLUSIONS_PATH)
    assert entries, "ingest/corpus-exclusions.yaml must exist and load"
    r79 = next(e for e in entries if e.doc_id == "dirty:r79-2015-spa")
    assert r79.detected_language == "es"
    assert r79.evidence and r79.detected_on
    for e in entries:
        assert e.detected_language not in ("en",), f"{e.doc_id}: an exclusion entry must be non-EN"
        assert e.evidence, f"{e.doc_id}: an exclusion entry must carry evidence"


# ── ingest-level: the corpus loader applies the gate ─────────────────

def _write_dirty_doc(root: Path, slug: str, body: str) -> None:
    meta = root / slug / "metanorma"
    meta.mkdir(parents=True)
    (meta / "document.adoc").write_text(
        f"= Test {slug}\n:docidentifier: OIML R 99:2020 (E)\n:language: en\n:edition: 2020\n\n== Scope\n\n{body}\n",
        encoding="utf-8",
    )


def test_load_corpus_excludes_non_en_content(monkeypatch, tmp_path: Path):
    from ingest import parse

    _write_dirty_doc(tmp_path, "r99-2020-e", EN_BODY)
    _write_dirty_doc(tmp_path, "r98-2019-e", ES_BODY)  # ES content, header lies
    monkeypatch.setattr(parse, "DIRTY_DIR", tmp_path)
    excluded = []
    docs = parse.load_corpus("dirty", excluded_out=excluded)
    assert [d.slug for d in docs] == ["r99-2020-e"]
    assert len(excluded) == 1
    assert excluded[0].doc_id == "dirty:r98-2019-e"
    assert excluded[0].detected == "es"
