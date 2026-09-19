"""Identifier codecs (konneal A2): each publisher has an identifier
grammar — how a document's canonical identifier (OIML R 60-2) is read
from a rendering and how it becomes a slug. The profile declares the
codec; producers and the site consume it so both sides always agree.

The slug rule is generic (lowercase; every non-alphanumeric run becomes
one dash). The grammar is the publisher-specific part.
"""
from __future__ import annotations

import re
from pathlib import Path

import yaml

# Citation grammars (the graph's `cites` edges): what a bibliography text
# cites. The generic floor recognizes the international standards families
# every publisher's bibliographies reference; the publisher codec adds its
# own series. The match shapes are deliberately pubid-normalizable — when
# pubid-ts lands, these become parser calls without touching graph.py.
_CITED_GENERIC = [
    # "ISO 8601:2004", "ISO/IEC 17025", "ISO/IEC Guide 98-3"
    re.compile(
        r"\bISO(?:/IEC|/TS|/TR)?\s*(?:Guide\s+)?\d{1,5}(?:\s*[-–]\s*\d+)?(?:\s*:\s*\d{4})?"
    ),
    # "IEC 60068-2-6", "IEC 61010"
    re.compile(r"\bIEC\s*\d{4,6}(?:\s*[-–]\s*\d+)?(?:\s*[-–]\s*\d+)?(?:\s*:\s*\d{4})?"),
]


def normalize_cite(label: str) -> tuple[str, str]:
    """A cited reference's graph identity: (node id, display label)."""
    label = re.sub(r"\s+", " ", label)
    return "cite:" + re.sub(r"[^A-Za-z0-9]+", "-", label).strip("-"), label


def _scan_cited(text: str, grammars: list[re.Pattern[str]]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for rx in grammars:
        for m in rx.finditer(text):
            nid, label = normalize_cite(m.group(0))
            if nid not in seen:
                seen.add(nid)
                out.append((nid, label))
    return out

_CODEC_CACHE: dict[str, "Codec"] = {}


def slugify(identifier: str) -> str:
    """The one slug rule — MUST match the site's docSlug() exactly."""
    return re.sub(r"[^a-z0-9]+", "-", identifier.lower()).strip("-")


class Codec:
    """Base codec: a plain slug over whatever string it is given."""

    name = "plain-slug"

    def extract_identifier(self, text: str) -> str:
        return ""

    def slug(self, identifier: str) -> str:
        return slugify(identifier)

    def cited_refs(self, text: str) -> list[tuple[str, str]]:
        """What a bibliography text cites: (cite node id, label) pairs.
        The floor recognizes ISO/IEC references — every standards
        bibliography carries them, publisher or not."""
        return _scan_cited(text, _CITED_GENERIC)


class OimlPubidCodec(Codec):
    """OIML's grammar: 'reference OIML R 60-1:2021' / bare
    'OIML R 60-1:2017' in a rendering; part numbers are significant
    (OIML R 60-1), the year is not part of the slug."""

    name = "oiml-pubid"
    _REF = re.compile(r"reference\s+(OIML\s+(?:R|D|B|G|E|S)\s*\d+(?:-\d+)?):\d{4}")
    _BARE = re.compile(r"(OIML\s+(?:R|D|B|G|E|S)\s*\d+(?:-\d+)?):\d{4}")
    # the V series (vocabularies) and the S series (seminar reports)
    # are bibliography-only in the corpus today: they do not head a
    # rendering, but bibliographies cite "OIML V 2-200", "OIML V 1:2013",
    # "OIML S 6:2011"
    _CITED_OIML = re.compile(
        r"\bOIML\s+[RDBGEVS]\s*\d{1,3}(?:\s*[-–]\s*[0-9A-Za-z]{1,3})?(?:\s*:\s*\d{4})?"
    )

    def extract_identifier(self, text: str) -> str:
        m = self._REF.search(text[:60000]) or self._BARE.search(text[:60000])
        return m.group(1) if m else ""

    def cited_refs(self, text: str) -> list[tuple[str, str]]:
        return _scan_cited(text, [self._CITED_OIML, *_CITED_GENERIC])


_CODECS: dict[str, type[Codec]] = {
    "plain-slug": Codec,
    "oiml-pubid": OimlPubidCodec,
}


def codec_for_profile(profile_dir: Path | str = "profile") -> Codec:
    """The profile declares its codec; unknown names fail loudly."""
    pub = yaml.safe_load((Path(profile_dir) / "publisher.yaml").read_text())
    name = pub.get("codec", "plain-slug")
    if name not in _CODECS:
        raise ValueError(f"codec {name!r} is not registered — known: {sorted(_CODECS)}")
    return _CODECS[name]()
