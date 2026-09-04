"""Document-level language verification + the EN-only exclusion list (issue #72).

The corpus directive (2026-08-24) is EN-only: a document whose CONTENT is
not English never enters the index. The declared language is source
metadata and lies — R 79:2015's Spanish edition declares `:language: en`
and served 'producto' chunks against English queries, and as the family's
apparent newest edition it demoted the legitimate R 79:1997 EN chunks in
edition steering. Verification derives each edition's actual language
from its content (stopword ratios over a document-level sample); a
confident non-EN verdict excludes the WHOLE edition, and every exclusion
lands on the checked-in list `ingest/corpus-exclusions.yaml` with its
evidence — the auditable record of what the EN index refuses and why.

Exclusion is whole-edition, never per-chunk: EN editions officially embed
French terminology annexes (R 76:2006 sec 17) and trilingual examples —
official content that stays. Chunk-level tagging for those lives in
ingest/fts.py (TODO.remaining/09); this module guards the document gate.
"""
from __future__ import annotations

import re
from pathlib import Path

from pydantic import BaseModel, Field

from .config import INGEST_LANGUAGES
from .models import DocRecord

EXCLUSIONS_PATH = Path(__file__).resolve().parent / "corpus-exclusions.yaml"

# Stopword sets mirror the unit-level tagger in ingest/fts.py — keep them
# in step. A document-level verdict samples far more text than a chunk, so
# the dominance bar is higher: a bilingual annex never outweighs the body.
STOPWORDS: dict[str, set[str]] = {
    "en": {"the", "and", "of", "to", "in", "is", "that", "for", "with", "as"},
    "fr": {"le", "la", "les", "de", "des", "et", "est", "une", "dans", "pour"},
    "es": {"el", "la", "los", "las", "de", "que", "y", "una", "para", "con"},
    "de": {"der", "die", "das", "und", "ist", "von", "mit", "für", "den", "dem"},
}

WORD_RE = re.compile(r"[a-zà-öø-ÿ]+")
# Hebrew, Arabic (+ supplements), Cyrillic, CJK, kana, Hangul: a declared-EN
# edition whose letters are mostly non-Latin is not English whatever the
# OCR'd header says.
NONLATIN_RE = re.compile(
    "[\u0590-\u05ff\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff"
    "\u0400-\u04ff\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]"
)

SAMPLE_CHARS = 30000      # ~5000 words from the document body's start
MIN_SAMPLE_WORDS = 150    # below this there is no defensible verdict (shells)
MIN_HITS = 10             # the winner needs real support, not a stray 'de'
DOMINANCE = 2.0           # document-level: the winner must double the runner-up
NONLATIN_SHARE = 0.3      # >30% non-Latin letters → not an English document


# ISO 639-2 → 639-1 for the detected languages: producer metadata (the MKO
# lane) can carry the 3-letter form
_LANG3 = {"eng": "en", "fra": "fr", "fre": "fr", "spa": "es", "deu": "de", "ger": "de"}


def normalize_language(code: str) -> str:
    return _LANG3.get((code or "").strip().lower(), (code or "").strip().lower()) or "en"


class Detection(BaseModel):
    detected: str | None = None   # None = inconclusive, keep the declared language
    scores: dict[str, int] = Field(default_factory=dict)
    words: int = 0
    nonlatin_share: float = 0.0


def detect_document_language(text: str) -> Detection:
    """Stopword-ratio langid over a document-level sample. Conservative by
    design: inconclusive samples (short, table-heavy, genuinely bilingual)
    return None and the declared language stands — verification only ever
    overrides metadata on a confident verdict."""
    sample = text[:SAMPLE_CHARS]
    words = WORD_RE.findall(sample.lower())
    latin_letters = sum(len(w) for w in words)
    nonlatin_letters = len(NONLATIN_RE.findall(sample))
    total_letters = latin_letters + nonlatin_letters
    share = nonlatin_letters / total_letters if total_letters else 0.0
    scores = {lang: sum(1 for w in words if w in stop) for lang, stop in STOPWORDS.items()}
    if total_letters > 200 and share > NONLATIN_SHARE:
        return Detection(detected="non-latin", scores=scores, words=len(words), nonlatin_share=share)
    if len(words) < MIN_SAMPLE_WORDS:
        return Detection(scores=scores, words=len(words), nonlatin_share=share)
    best = max(scores, key=scores.get)
    runner_up = sorted(scores.values(), reverse=True)[1]
    if scores[best] < MIN_HITS or scores[best] < DOMINANCE * runner_up:
        return Detection(scores=scores, words=len(words), nonlatin_share=share)
    return Detection(detected=best, scores=scores, words=len(words), nonlatin_share=share)


class CorpusExclusion(BaseModel):
    """One checked-in whole-edition exclusion (the audit record)."""

    doc_id: str                       # ingest identity: "dirty:r79-2015-spa"
    docidentifier: str = ""           # as the source (mis)declared it
    edition: str = ""
    declared_language: str = "en"
    detected_language: str
    evidence: str = ""
    detected_on: str = ""
    reference: str = ""


def load_exclusions(path: Path = EXCLUSIONS_PATH) -> list[CorpusExclusion]:
    """The checked-in exclusion list — every whole-edition non-EN exclusion
    the EN index applies, with its evidence. A missing file means no list,
    not an error (fresh checkouts before the first entry)."""
    if not path.is_file():
        return []
    import yaml

    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return [CorpusExclusion(**e) for e in data.get("exclusions") or []]


class LanguageCheck(BaseModel):
    doc_id: str
    docidentifier: str = ""
    edition: str = ""
    declared: str = "en"
    detected: str | None = None
    listed: bool = False              # on the checked-in exclusion list
    excluded: bool = False
    evidence: str = ""


def _doc_text(doc: DocRecord) -> str:
    return "\n\n".join(s.text for s in doc.sections if s.text)


def check_doc_language(doc: DocRecord, exclusions: list[CorpusExclusion] | None = None) -> LanguageCheck:
    """Verify one document's language against its content. Whole-edition:
    a confident non-EN content verdict (or a checked-in list entry, which
    wins over an inconclusive sample) excludes the document from the EN
    index. An English verdict never rescues a document the declared
    language already excluded — verification tightens, never loosens."""
    declared = normalize_language(doc.language or "en")
    base = {"doc_id": doc.doc_id, "docidentifier": doc.docidentifier, "edition": doc.edition, "declared": declared}
    entry = next((e for e in exclusions or [] if e.doc_id == doc.doc_id), None)
    if entry is not None:
        return LanguageCheck(
            **base,
            detected=entry.detected_language,
            listed=True,
            excluded=entry.detected_language not in INGEST_LANGUAGES,
            evidence=f"on ingest/corpus-exclusions.yaml ({entry.detected_on or 'undated'}): {entry.evidence}",
        )
    if declared not in INGEST_LANGUAGES:
        # already excluded by the declared-language gate; verification only
        # speaks for documents that would otherwise enter the EN index
        return LanguageCheck(**base)
    det = detect_document_language(_doc_text(doc))
    if det.detected is None or det.detected in INGEST_LANGUAGES:
        return LanguageCheck(**base, detected=det.detected)
    if det.detected == "non-latin":
        evidence = f"{det.nonlatin_share:.0%} of sampled letters are non-Latin script"
    else:
        hits = ", ".join(f"{lang}={n}" for lang, n in sorted(det.scores.items(), key=lambda kv: -kv[1]))
        evidence = f"stopword hits over {det.words} sampled words: {hits}"
    return LanguageCheck(**base, detected=det.detected, excluded=True, evidence=evidence)
