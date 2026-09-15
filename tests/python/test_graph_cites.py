"""The graph's `cites` edges: the bibliography extraction that turns
"what does X cite" into a graph traversal instead of a lucky vector
match. The citation grammar is the codec's — publisher series on top of
the generic ISO/IEC floor.
"""

from ingest.codecs import Codec, OimlPubidCodec, normalize_cite
from ingest.graph import edition_node

OIML = OimlPubidCodec()
PLAIN = Codec()  # the generic floor directly — the repo's own profile is publisher-specific

R60_BIB = (
    "22.3 Bibliographie\n"
    "[1] OIML R 76 Instruments de pesage à fonctionnement non-automatique, 2006\n"
    "[2] OIML V 2-200 Vocabulaire international de métrologie\n"
    "[3] ISO 376 Metallic materials — calibration of force-proving instruments\n"
    "[4] IEC 60068-2-6 Environmental testing\n"
    "[5] ISO/IEC Guide 98-3 Uncertainty of measurement\n"
)

REGISTRY = {
    "doc:OIML-R-60-1967": {"family": "R-60", "part": None, "edition": "1967", "active": 0},
    "doc:OIML-R-60-2017": {"family": "R-60", "part": None, "edition": "2017", "active": 1},
    "doc:OIML-R-60-1-2017": {"family": "R-60", "part": "1", "edition": "2017", "active": 1},
}


def test_normalize_cite_is_pubid_shaped():
    assert normalize_cite("ISO 8601:2004") == ("cite:ISO-8601-2004", "ISO 8601:2004")
    assert normalize_cite("OIML V 2-200") == ("cite:OIML-V-2-200", "OIML V 2-200")
    assert normalize_cite("ISO/IEC Guide 98-3") == ("cite:ISO-IEC-Guide-98-3", "ISO/IEC Guide 98-3")


def test_oiml_codec_extracts_series_and_generic_families():
    refs = dict(OIML.cited_refs(R60_BIB))
    assert "cite:OIML-R-76" in refs
    assert "cite:OIML-V-2-200" in refs
    assert "cite:ISO-376" in refs
    assert "cite:IEC-60068-2-6" in refs
    assert "cite:ISO-IEC-Guide-98-3" in refs
    assert refs["cite:OIML-V-2-200"] == "OIML V 2-200"


def test_plain_floor_carries_iso_iec_but_no_publisher_series():
    refs = dict(PLAIN.cited_refs(R60_BIB))
    assert "cite:ISO-376" in refs
    assert "cite:IEC-60068-2-6" in refs
    assert not any(k.startswith("cite:OIML-") for k in refs)


def test_oiml_codec_keeps_edition_years_when_present():
    refs = dict(OIML.cited_refs("see ISO 8601:2004 and OIML R 111:1994"))
    assert "cite:ISO-8601-2004" in refs
    assert "cite:OIML-R-111-1994" in refs


def test_prose_mentions_of_iso_count_only_as_themselves():
    # "follow ISO 690" yields ISO 690 — the extraction records what the
    # text names, filtering happens by section (bibliography chunks only)
    refs = dict(OIML.cited_refs("The rules contained in ISO 690 shall be followed."))
    assert list(refs) == ["cite:ISO-690"]


def test_edition_node_exact_then_active_then_newest():
    assert edition_node(REGISTRY, "OIML R 60", "1967") == "doc:OIML-R-60-1967"
    assert edition_node(REGISTRY, "OIML R 60", "") == "doc:OIML-R-60-2017"
    assert edition_node(REGISTRY, "OIML R 60", "1999") == "doc:OIML-R-60-2017"  # unknown ed → active
    assert edition_node(REGISTRY, "OIML R 60-1", "") == "doc:OIML-R-60-1-2017"  # part stays in its lane
    assert edition_node(REGISTRY, "OIML R 999", "") is None
