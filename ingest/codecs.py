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


class OimlPubidCodec(Codec):
    """OIML's grammar: 'reference OIML R 60-1:2021' / bare
    'OIML R 60-1:2017' in a rendering; part numbers are significant
    (OIML R 60-1), the year is not part of the slug."""

    name = "oiml-pubid"
    _REF = re.compile(r"reference\s+(OIML\s+(?:R|D|B|G|E)\s*\d+(?:-\d+)?):\d{4}")
    _BARE = re.compile(r"(OIML\s+(?:R|D|B|G|E)\s*\d+(?:-\d+)?):\d{4}")

    def extract_identifier(self, text: str) -> str:
        m = self._REF.search(text[:60000]) or self._BARE.search(text[:60000])
        return m.group(1) if m else ""


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
