from __future__ import annotations

import html
import re
from pathlib import Path

from bs4 import BeautifulSoup

from .config import CLEAN_DIR, DIRTY_DIR, INGEST_LANGUAGES, SHELL_WORD_THRESHOLD
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
ZERO_WIDTH = dict.fromkeys(map(ord, "​‌‍﻿"), None)
BLOCK_ATTR_RE = re.compile(r"^\[[^[\]]*\]$")
SET_ATTR_RE = re.compile(r"^\{set:[^}]+\}$")
ANCHOR_RE = re.compile(r"^\[\[[\w.:-]+\]\]$")
TABLE_ROW_RE = re.compile(r"^(?:[v^<>]|[0-9.]+\+?)+\s*\|(?!\|)")
CELL_MARKER_RE = re.compile(r"^[v^<>\d.+\s]*$")
BOILERPLATE_RE = re.compile(
    r"© OIML|rue Turgot|Telephone:|Fax:|Tel:|ISBN|Bureau International de Métrologie Légale \d|"
    r"^\(draft |^Date: |^TC \d|^Second edition|^First edition|^Edition |org.oiml"
)


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
    """Adoc → retrievable text: entities decoded, zero-width junk gone,
    block attributes and include/comment noise dropped, |=== tables
    flattened to readable rows (normative tables must stay retrievable)."""
    text = html.unescape(text)
    text = text.translate(ZERO_WIDTH)
    out: list[str] = []
    in_table = False
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("include::") or s.startswith("//"):
            continue
        if SET_ATTR_RE.match(s) or BLOCK_ATTR_RE.match(s) or ANCHOR_RE.match(s):
            continue
        is_delim = s.replace("=", "").strip() == "|" and len(s.replace(" ", "")) >= 3
        if is_delim:
            in_table = not in_table
            continue
        if in_table or s.startswith("|") or TABLE_ROW_RE.match(s):
            cells = [c.strip() for c in s.split("|") if c.strip()]
            cells = [c for c in cells if not CELL_MARKER_RE.match(c)]
            if cells:
                out.append(" | ".join(cells))
            continue
        if s == "+":
            continue
        out.append(line.rstrip())
    body = "\n".join(out)
    body = re.sub(r"\n{3,}", "\n\n", body).strip()
    return body


HEADING_NUM_RE = re.compile(r"^(\d+(?:\.\d+)*)\.?\s")
YEAR_LANG_RE = re.compile(r"\s*:\s*(19|20)\d{2}\s*(\([A-Z/]+\))?\s*$")
# the dirty corpus's OCR render embeds escaped HTML markup as literal text
LITERAL_TAG_RE = re.compile(r"</?[a-zA-Z][^<>]{0,120}>")
GUID_ANCHOR_RE = re.compile(r"^_?[0-9a-f]{8}-[0-9a-f]{4}-", re.I)


def strip_literal_tags(text: str) -> str:
    return re.sub(r"\s{2,}", " ", LITERAL_TAG_RE.sub(" ", text)).strip()


def normalize_identifier(ident: str) -> str:
    """Stable publication identity: strip trailing year/language markers so
    'OIML R 60-1:2017 (E)' and 'OIML R 60-1:2021' group as 'OIML R 60-1'."""
    out = ident.strip()
    for _ in range(2):
        out = YEAR_LANG_RE.sub("", out)
    return re.sub(r"\s+", " ", out).strip()


def _html_section_anchor(el) -> tuple[str, str]:
    """Anchor + title from a rendered heading. The clause number in the
    heading text wins (it matches citation practice); the element id is the
    fallback."""
    title = el.get_text(" ", strip=True)
    title = re.sub(r"\s+", " ", title)
    m = HEADING_NUM_RE.match(title)
    if m:
        return m.group(1), title
    el_id = el.get("id") or ""
    if GUID_ANCHOR_RE.match(el_id):
        # machine-generated element ids are meaningless in citations
        return "", title
    return el_id, title


def _table_text(tbl) -> str:
    cap = tbl.find("caption")
    cap_text = re.sub(r"\s+", " ", cap.get_text(" ", strip=True)) if cap else ""
    rows = []
    for tr in tbl.find_all("tr"):
        cells = [strip_literal_tags(c.get_text(" ", strip=True)) for c in tr.find_all(["th", "td"])]
        cells = [c for c in cells if c]
        if cells:
            rows.append(" | ".join(cells))
    out = (f"Table — {cap_text}\n" if cap_text else "") + "\n".join(rows)
    return out.strip()


def extract_html_sections(path: Path) -> list[Section]:
    """Extract retrievable sections from the COMPILED Metanorma HTML —
    rendered tables (caption + rows), anchored clause headings, paragraphs
    and lists. This is the preferred source: the render already resolved
    all AsciiDoc syntax."""
    soup = BeautifulSoup(path.read_text(encoding="utf-8", errors="replace"), "html.parser")
    for tag in soup(["script", "style", "nav"]):
        tag.decompose()
    body = soup.body or soup

    sections: list[Section] = []
    cur_anchor, cur_title = "", ""
    buf: list[str] = []

    def flush():
        text = re.sub(r"\n{3,}", "\n\n", "\n".join(b for b in buf if b)).strip()
        if text:
            title = cur_title
            lines = text.split("\n")
            # numbered term-entries (title "3.1.1"): the term name leads the body
            if re.fullmatch(r"[\d.]+", title) and " | " in lines[0]:
                title = f"{title} {lines[0].split(' | ')[0]}"
            sections.append(Section(anchor=cur_anchor, title=title, text=text, source_file="html"))
        buf.clear()

    for el in body.find_all(["h2", "h3", "h4", "h5", "p", "li", "table", "pre"]):
        # skip anything nested inside an already-captured container
        if el.name != "table" and el.find_parent("table"):
            continue
        if el.name not in ("li",) and el.find_parent("li"):
            continue
        if el.name == "pre" and el.find_parent("pre"):
            continue
        if el.name in ("h2", "h3", "h4", "h5"):
            flush()
            cur_anchor, cur_title = _html_section_anchor(el)
            continue
        if el.name == "table":
            t = _table_text(el)
            if t:
                buf.append(t)
            continue
        if el.name == "li":
            t = strip_literal_tags(el.get_text(" ", strip=True))
            if t:
                buf.append(f"- {t}")
            continue
        if el.name == "pre":
            t = el.get_text("\n", strip=True)
            if t:
                buf.append(t)
            continue
        t = el.get_text(" ", strip=True)
        if t and not BOILERPLATE_RE.search(t):
            buf.append(strip_literal_tags(t))
    flush()
    return sections


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
    edition = attrs.get("edition", "").strip()
    year_in_id = re.search(r":(\d{4})", docidentifier)
    if year_in_id:
        edition = year_in_id.group(1)
    elif not re.fullmatch(r"(19|20)\d{2}", edition):
        # part/edition numbers like "2" are not years — never render as ":2"
        edition = edition_from_slug(slug)
    language = attrs.get("language", "").strip() or language_from_slug(slug)
    html_path = (
        metanorma_dir / "document.html"
        if corpus == "clean"
        else doc_root / "verify" / "document.html"
    )
    sections: list[Section] = []
    if html_path.is_file():
        try:
            sections = extract_html_sections(html_path)
        except Exception as e:  # noqa: BLE001 — fall back to the adoc sections
            print(f"  ! html extract error {slug}: {e}")
    if not sections:
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
            if rec and rec.language in INGEST_LANGUAGES:
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
