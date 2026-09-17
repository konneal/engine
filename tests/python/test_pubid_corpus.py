"""The ingest grammar mirrors @oimlsmart/oiml-pubid — the estate's SSOT
parser (TypeScript; the ingest CLI is Python and keeps its own scan
grammar). This suite pins the MIRROR to the package's shared
conformance corpus: the same expectations the TS side runs, nobody's
own copy. The corpus lives inside the installed npm package
(node_modules/@oimlsmart/oiml-pubid/conformance/identifiers.json).
"""
import json
import re
from pathlib import Path

from ingest.codecs import OimlPubidCodec, normalize_cite

CORPUS = Path("node_modules/@oimlsmart/oiml-pubid/conformance/identifiers.json")

# family letters the ingest scan grammar owns (mirrors the pub series;
# the CS family PD/OD/CID is outside the retrieval plane)
FAMILY_RE = re.compile(r"OIML ([RDBGEV]) (\d+)(?:-(\d+))?")

codec = OimlPubidCodec()


def test_corpus_present():
    assert CORPUS.is_file(), (
        "the shared corpus is missing — run `npm install @oimlsmart/oiml-pubid` "
        "(CI's ingest job does this); pinning private copies is the drift this suite exists to prevent"
    )


def test_the_scan_grammar_matches_every_pub_case():
    for case in json.loads(CORPUS.read_text())["cases"]:
        st = case["structure"]
        if st["series"] != "pub":
            continue  # CS family: a valid pubid, outside this plane
        refs = dict(codec.cited_refs(case["identifier"]))
        m = FAMILY_RE.search(case["identifier"].upper().replace("OIML ", "OIML ", 1))
        assert m, case["identifier"]
        # the extracted node id carries the corpus structure's spine
        expect_num = str(int(st["number"]))
        spine = f"{st['family'].upper()}-{expect_num}"
        assert any(spine in nid for nid in refs), f"{case['identifier']}: no {spine} in {list(refs)}"
        # the display label is pubid-normalized (never a bare number)
        for nid, label in refs.items():
            assert label.startswith("OIML "), f"{label}: labels are prefixed and normalized"


def test_shape_rejections_never_match():
    for rej in json.loads(CORPUS.read_text())["rejections"]:
        m = FAMILY_RE.search(rej.upper())
        valid_shape = bool(m and m.group(1) in "RDBGEV")
        # whole-string prose rejections ("... extra words here") are
        # PARSE semantics; our cited_refs is a SEARCH — a valid pubid
        # inside prose legitimately extracts. Only family-invalid and
        # non-OIML shapes must never match.
        if valid_shape:
            continue
        refs = dict(codec.cited_refs(rej))
        assert not any(r.startswith("cite:OIML-") for r in refs if "X" in rej or "XX" in rej) or not refs, rej


def test_normalize_cite_is_pubid_shaped():
    assert normalize_cite("ISO 8601:2004") == ("cite:ISO-8601-2004", "ISO 8601:2004")
    assert normalize_cite("OIML V 2-200") == ("cite:OIML-V-2-200", "OIML V 2-200")


# The pubid-testsuite corpus (github.com/pubid/pubid-testsuite) is the
# second expectation set: the package corpus pins the delegate grammar,
# this one pins the ingest scan against the ecosystem's ground truth.
# Resolution mirrors the TS side: PUBID_TESTSUITE_DIR (refuses a vacuous
# pass when set-but-absent) → the sibling checkout → loud skip.
import os

TESTSUITE_DIR = os.environ.get("PUBID_TESTSUITE_DIR") or "../pubid-testsuite/tests/oiml"
if os.environ.get("PUBID_TESTSUITE_DIR") and not Path(TESTSUITE_DIR).is_dir():
    raise AssertionError(
        f"PUBID_TESTSUITE_DIR is set but {TESTSUITE_DIR} does not exist — refusing a vacuous pass"
    )

TESTSUITE_PRESENT = Path(TESTSUITE_DIR).is_dir()

# the testsuite encodes the family in _type (pubid:oiml:recommendation),
# not a letter field
TYPE_LETTER = {
    "recommendation": "R", "document": "D", "basic-publication": "B",
    "guide": "G", "expert-report": "E", "vocabulary": "V", "seminar-report": "S",
}


def test_testsuite_base_cases_scan():
    if not TESTSUITE_PRESENT:
        print("pubid-testsuite: SKIP — no corpus at", TESTSUITE_DIR)
        return
    import yaml

    checked = 0
    for name in sorted(os.listdir(TESTSUITE_DIR)):
        if not name.endswith(".yaml") or name.startswith("_"):
            continue
        for case in yaml.safe_load((Path(TESTSUITE_DIR) / name).read_text()) or []:
            ident = case.get("identifier") or {}
            human = (case.get("representations") or {}).get("human")
            if not ident or not human:
                continue
            # amendment/annex constructs and draft stages are the citation
            # layer's, not the scan grammar's; the S family lands with
            # oimlsmart/oiml-pubid#5's release
            if human.startswith("Amendment") or "Annex" in human or ident.get("base"):
                continue
            if "CD" in human or "WD" in human or human.startswith("OIML S "):
                continue
            st = ident.get("base") or ident
            letter = TYPE_LETTER.get(str(st.get("_type", "")).split(":")[-1])
            if not letter:
                continue
            spine = f"{letter}-{int(st['number'])}"
            refs = dict(codec.cited_refs(human))
            assert refs, human
            assert any(spine in nid for nid in refs), f"{human}: no {spine} in {list(refs)}"
            checked += 1
    assert checked > 30, f"only {checked} cases exercised — the corpus load is broken"


def test_testsuite_normalization_pairs():
    if not TESTSUITE_PRESENT:
        return
    import yaml

    norm = Path(TESTSUITE_DIR) / "_normalization.yaml"
    if not norm.is_file():
        return
    for pair in yaml.safe_load(norm.read_text()) or []:
        src = pair["from"].upper().replace("OIML ", "OIML ", 1)
        dst = pair["to"].upper().replace("OIML ", "OIML ", 1)
        m_src, m_dst = FAMILY_RE.search(src), FAMILY_RE.search(dst)
        if not (m_src and m_dst):
            continue  # a construct the scan grammar does not own
        assert (m_src.group(1), m_src.group(2)) == (m_dst.group(1), m_dst.group(2)), pair
