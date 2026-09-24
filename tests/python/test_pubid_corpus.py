"""The ingest scan grammar's conformance suite: the pubid-testsuite
corpus (github.com/pubid/pubid-testsuite) is the ecosystem's ground
truth — the same expectations the TS codec runs (tests/
pubid-testsuite.test.ts), nobody's private copy. The estate's former
grammar package (@oimlsmart/oiml-pubid) retired into the unified
grammar; its corpus migrated into the testsuite (the merged estate
corpus head).
"""
import os
import re
from pathlib import Path

import yaml

from ingest.codecs import OimlPubidCodec, normalize_cite

codec = OimlPubidCodec()

# family letters the ingest scan grammar owns; the CS family (PD/OD/CID)
# is a valid pubid, outside this retrieval plane
FAMILY_RE = re.compile(r"OIML ([RDBGEVS]) (\d+)(?:-(\d+))?")

# the testsuite encodes the family in _type (pubid:oiml:recommendation),
# not a letter field
TYPE_LETTER = {
    "recommendation": "R", "document": "D", "basic-publication": "B",
    "guide": "G", "expert-report": "E", "vocabulary": "V",
    "seminar-report": "S",
}

DIR_CANDIDATES = [
    os.environ.get("PUBID_TESTSUITE_DIR"),
    "../pubid-testsuite/tests/oiml",
    str(Path.home() / "src/pubid/pubid-testsuite/tests/oiml"),
]
if os.environ.get("PUBID_TESTSUITE_DIR") and not Path(os.environ["PUBID_TESTSUITE_DIR"]).is_dir():
    raise AssertionError(
        f"PUBID_TESTSUITE_DIR is set but {os.environ['PUBID_TESTSUITE_DIR']} does not exist — refusing a vacuous pass"
    )
TESTSUITE_DIR = next((d for d in DIR_CANDIDATES if d and Path(d).is_dir()), DIR_CANDIDATES[-1])
TESTSUITE_PRESENT = Path(TESTSUITE_DIR).is_dir()


def _cases():
    for name in sorted(os.listdir(TESTSUITE_DIR)):
        if not name.endswith(".yaml") or name.startswith("_"):
            continue
        for case in yaml.safe_load((Path(TESTSUITE_DIR) / name).read_text()) or []:
            ident = case.get("identifier") or {}
            human = (case.get("representations") or {}).get("human")
            if ident and human:
                yield ident, human


def test_testsuite_base_cases_scan():
    if not TESTSUITE_PRESENT:
        print("pubid-testsuite: SKIP — no corpus at", TESTSUITE_DIR)
        return
    checked = 0
    for ident, human in _cases():
        # amendment/annex constructs and draft stages are the citation
        # layer's, not the scan grammar's
        if human.startswith("Amendment") or "Annex" in human or ident.get("base"):
            continue
        if "CD" in human or "WD" in human:
            continue
        members = [ident.get("first"), ident.get("second")]
        oiml_side = next((m for m in members if m and str(m.get("_type", "")).startswith("pubid:oiml")), None)
        st = oiml_side or (ident.get("base") or ident)
        letter = TYPE_LETTER.get(str(st.get("_type", "")).split(":")[-1])
        if not letter or "number" not in st:
            continue
        spine = f"{letter}-{int(st['number'])}"
        refs = dict(codec.cited_refs(human))
        assert refs, human
        assert any(spine in nid for nid in refs), f"{human}: no {spine} in {list(refs)}"
        for nid, label in refs.items():
            assert label.startswith("OIML ") or not nid.startswith("cite:OIML-"), f"{label}: labels are prefixed and normalized"
        checked += 1
    assert checked > 30, f"only {checked} cases exercised — the corpus load is broken"


def test_testsuite_dual_published_resolves_the_oiml_side():
    if not TESTSUITE_PRESENT:
        return
    checked = 0
    for ident, human in _cases():
        if str(ident.get("_type", "")) != "pubid:oiml:dual-published":
            continue
        members = [ident.get("first"), ident.get("second")]
        oiml_side = next(m for m in members if m and str(m.get("_type", "")).startswith("pubid:oiml"))
        spine = f"{TYPE_LETTER[str(oiml_side['_type']).split(':')[-1]]}-{int(oiml_side['number'])}"
        refs = dict(codec.cited_refs(human))
        assert any(spine in nid for nid in refs), f"{human}: the OIML side's spine must extract from the pipe print"
        checked += 1
    assert checked >= 2, f"only {checked} dual cases exercised — the merged corpus is missing"


def test_testsuite_rejections_never_match():
    rej_file = Path(TESTSUITE_DIR) / "_rejections.yaml"
    if not rej_file.is_file():
        return
    for rej in yaml.safe_load(rej_file.read_text()) or []:
        m = FAMILY_RE.search(str(rej).upper())
        if m and m.group(1) in "RDBGEVS":
            continue  # a valid shape in prose: the scan legitimately extracts
        refs = dict(codec.cited_refs(str(rej)))
        assert not any(nid.startswith("cite:OIML-") for nid in refs), rej


def test_normalize_cite_is_pubid_shaped():
    assert normalize_cite("ISO 8601:2004") == ("cite:ISO-8601-2004", "ISO 8601:2004")
    assert normalize_cite("OIML V 2-200") == ("cite:OIML-V-2-200", "OIML V 2-200")
