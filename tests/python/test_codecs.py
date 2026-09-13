"""Identifier codecs (konneal A2): the registry resolves the
profile-declared codec, and the slug rule is the cross-boundary
invariant. Grammar-specific assertions (e.g. the OIML pubid rules) are
publisher tests and live in the deployment repository.
"""

from ingest.codecs import _CODECS, codec_for_profile, slugify


def test_profile_declares_the_fixture_codec():
    assert codec_for_profile("profile").name == "plain-slug"


def test_the_registry_knows_the_reference_grammars():
    assert set(_CODECS) >= {"plain-slug", "oiml-pubid"}


def test_unknown_codec_fails_loudly(tmp_path):
    (tmp_path / "publisher.yaml").write_text("id: x\ncodec: nope\n")
    try:
        codec_for_profile(tmp_path)
    except ValueError as e:
        assert "nope" in str(e)
    else:
        raise AssertionError("unknown codec must fail loudly")


def test_the_slug_rule_is_the_one_formula():
    assert slugify("Fixture Doc 12-A") == "fixture-doc-12-a"
    assert slugify("  OIML  R 60-1 ") == "oiml-r-60-1"
