"""Identifier codecs (konneal A2): the profile-declared grammar, and the
cross-boundary invariant — the producer's slug MUST equal the site's
docSlug() for real corpus identifiers (golden vectors).
"""

from ingest.codecs import codec_for_profile, slugify

CODEC = codec_for_profile("profile")

# (docidentifier → slug) golden vectors, drawn from the live corpus
VECTORS = [
    ("OIML R 60-1", "oiml-r-60-1"),
    ("OIML R 60-2", "oiml-r-60-2"),
    ("OIML R 60", "oiml-r-60"),
    ("OIML B 18", "oiml-b-18"),
    ("OIML D 29", "oiml-d-29"),
    ("OIML G 21", "oiml-g-21"),
]


def test_profile_declares_the_oiml_codec():
    assert CODEC.name == "oiml-pubid"


def test_identifier_extraction_from_a_rendering():
    html = 'This publication - reference OIML R 60-1:2021 - is an updated edition'
    assert CODEC.extract_identifier(html) == "OIML R 60-1"
    assert CODEC.extract_identifier("see OIML R 49:2006 (E)") == "OIML R 49"


def test_slugs_match_the_site_formula():
    for ident, slug in VECTORS:
        assert CODEC.slug(ident) == slug
        # the site's docSlug(): lowercase + [^a-z0-9]+ → '-', trimmed
        assert slugify(ident) == slug
