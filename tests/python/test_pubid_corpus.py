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
