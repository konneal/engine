from __future__ import annotations

import re
from pathlib import Path

from .config import CLEAN_DIR, DIRTY_DIR, SHELL_WORD_THRESHOLD
from .models import DocRecord, Section

ATTR_RE = re.compile(r"^:([A-Za-z0-9_-]+):\s*(.*)$", re.M)
DOCID_RE = re.compile(r"OIML\s+([RB DGE])\s*(\d+)", re.I)
BARE_DOCID_RE = re.compile(r"^([RB DGE])\s*(\d+)", re.I)
DOCTYPE_MAP = {
    "recommendation": "R",
    "document": "D",
    "basic": "B",
    "guide": "G",
    "expert": "E",
}
LANG_FROM_SLUG = [
    ("-ara", "ar"), ("-ar", "ar"),
    ("-fra", "fr"), ("-fr", "fr"), ("-f", "fr"),
    ("-ger", "de"), ("-deu", "de"), ("-de", "de"), ("-d", "de"),
    ("-esp", "es"), ("-es", "es"),
    ("-per", "fa"), ("-fas", "fa"), ("-fa", "fa"),
    ("-ukr", "uk"), ("-uk", "uk"),
    ("-srp", "sr"), ("-sr", "sr"),
    ("-pol", "pl"), ("-pl", "pl"),
    ("-eng", "en"), ("-en", "en"), ("-e", "en"),
]


def parse_header(adoc: str) -> tuple[str, dict[str, str]]:
    attrs = {m.group(1).lower(): m.group(2).strip() for m in ATTR_RE.finditer(adoc)}
    title = ""
    for line in adoc.splitlines():
        if line.startswith("= "):
            title = line[2:].strip()
            break
    return title, attrs


def language_from_slug(slug: str) -> str:
    for suffix, code in LANG_FROM_SLUG:
        if slug.endswith(suffix):
            return code
    return "en"


def edition_from_slug(slug: str) -> str:
    m = re.search(r"(19\d{2}|20\d{2})", slug)
    return m.group(1) if m else ""


def classify_identifier(title: str, attrs: dict[str, str], slug: str) -> tuple[str, str, str]:
    """Returns (docidentifier, doctype, doc_number) — header docidentifier wins."""
    docid = attrs.get("docidentifier", "")
    dm = DOCID_RE.search(docid) or BARE_DOCID_RE.match(docid)
    if dm:
        return docid, dm.group(1).upper(), dm.group(2)
    doctype = attrs.get("series", "").strip().upper()
    doc_number = attrs.get("docnumber", "").strip()
    if not doctype:
        dt = attrs.get("doctype", "")
        for word, letter in DOCTYPE_MAP.items():
            if word in dt:
                doctype = letter
                break
    if not doc_number:
        m = re.search(r"(?:^|[a-z])(\d{1,3})", slug)
        doc_number = m.group(1) if m else ""
    if doctype and doc_number:
        year = attrs.get("edition") or edition_from_slug(slug)
        suffix = f":{year}" if year else ""
        return f"OIML {doctype} {doc_number}{suffix}", doctype, doc_number
    return docid, doctype, doc_number


def clean_body(text: str) -> str:
    lines = []
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("include::") or s.startswith("//"):
            continue
        lines.append(line)
    out = "\n".join(lines)
    out = re.sub(r"\n{3,}", "\n\n", out).strip()
    return out


def parse_sections(sections_dir: Path, fallback_adoc: str | None) -> list[Section]:
    sections: list[Section] = []
    files = sorted(sections_dir.glob("*.adoc")) if sections_dir.is_dir() else []
    for f in files:
        raw = f.read_text(encoding="utf-8", errors="replace")
        body = clean_body(raw)
        if not body:
            continue
        anchor = ""
        m = re.match(r"^(\d+)", f.stem)
        if m:
            anchor = str(int(m.group(1)))
        title = ""
        tm = re.search(r"^==\s+(.+)$", body, re.M)
        if tm:
            title = tm.group(1).strip()
        elif anchor:
            title = f.name
        sections.append(Section(anchor=anchor, title=title, text=body, source_file=f.name))
    if not sections and fallback_adoc:
        # no sections dir: split the single document.adoc on level-2 headings
        parts = re.split(r"(?m)^==\s+", fallback_adoc)
        for i, part in enumerate(parts[1:], start=1):
            lines = part.split("\n", 1)
            title = lines[0].strip()
            body = clean_body(lines[1] if len(lines) > 1 else "")
            if body:
                sections.append(Section(anchor=str(i), title=title, text=body, source_file="document.adoc"))
    return sections


def parse_doc(doc_root: Path, corpus: str, slug: str) -> DocRecord | None:
    metanorma_dir = doc_root if corpus == "clean" else doc_root / "metanorma"
    adoc_path = metanorma_dir / "document.adoc"
    if not adoc_path.is_file():
        return None
    adoc = adoc_path.read_text(encoding="utf-8", errors="replace")
    title, attrs = parse_header(adoc)
    docidentifier, doctype, doc_number = classify_identifier(title, attrs, slug)
    edition = attrs.get("edition", "").strip() or edition_from_slug(slug)
    language = attrs.get("language", "").strip() or language_from_slug(slug)
    sections = parse_sections(metanorma_dir / "sections", adoc)
    word_count = sum(len(s.text.split()) for s in sections)
    tier = "curated" if corpus == "clean" else ("shell" if word_count < SHELL_WORD_THRESHOLD else "ocr-clean")
    return DocRecord(
        doc_id=f"{corpus}:{slug}",
        slug=slug,
        corpus=corpus,
        tier=tier,
        docidentifier=docidentifier,
        doctype=doctype,
        doc_number=doc_number,
        edition=edition,
        language=language,
        title=title or docidentifier or slug,
        word_count=word_count,
        sections=sections,
    )


def load_corpus(corpus: str) -> list[DocRecord]:
    root = CLEAN_DIR if corpus == "clean" else DIRTY_DIR
    docs: list[DocRecord] = []
    if not root.is_dir():
        return docs
    for doc_root in sorted(root.iterdir()):
        if not doc_root.is_dir() or doc_root.name.startswith("."):
            continue
        roots = [doc_root]
        if corpus == "clean" and not (doc_root / "document.adoc").is_file():
            # Metanorma collection: parts live in numbered/named subdirectories
            roots = sorted(
                p for p in doc_root.iterdir()
                if p.is_dir() and not p.name.startswith(".") and p.name != "templates"
                and (p / "document.adoc").is_file()
            )
        for part_root in roots:
            slug = doc_root.name if part_root is doc_root else f"{doc_root.name}/{part_root.name}"
            try:
                rec = parse_doc(part_root, corpus, slug)
            except Exception as e:  # noqa: BLE001 — one bad doc must not stop the run
                print(f"  ! parse error {slug}: {e}")
                continue
            if rec:
                docs.append(rec)
    return docs


def apply_precedence(docs: list[DocRecord]) -> tuple[list[DocRecord], list[DocRecord]]:
    """Clean wins over dirty for the same (doctype, number, edition, language).
    Never drops within a corpus — multi-part docs share identifiers by design."""
    clean_keys = {
        d.dedup_key for d in docs
        if d.corpus == "clean" and d.doctype and d.doc_number
    }
    kept: list[DocRecord] = []
    dropped: list[DocRecord] = []
    for d in docs:
        if (
            d.corpus == "dirty"
            and d.doctype
            and d.doc_number
            and d.dedup_key in clean_keys
        ):
            dropped.append(d)
        else:
            kept.append(d)
    return kept, dropped
