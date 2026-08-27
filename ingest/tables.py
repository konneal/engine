"""G1 prototype: table-aware chunks.

The compiled HTML carries real table structure (caption, header cells, body
rows) that the prose pipeline flattens away. This module extracts every
table as a typed record — header map + row tuples serialized for embedding,
original layout preserved for display — WITHOUT touching the live index:
output goes to artifacts/table-chunks.jsonl for inspection and a later
re-ingest window (chunk ids change → enrichment re-runs, ≈$50; needs an
explicit go).
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from bs4 import BeautifulSoup

from .config import DIRTY_DIR, CLEAN_DIR, INGEST_LANGUAGES
from .parse import load_corpus, apply_precedence, HEADING_NUM_RE, strip_literal_tags, normalize_identifier

HEADING_TAGS = ("h2", "h3", "h4", "h5")


@dataclass
class TableExtract:
    clause_anchor: str
    clause_title: str
    caption: str
    columns: list[str] = field(default_factory=list)
    rows: list[list[str]] = field(default_factory=list)
    header_heuristic: bool = False


def html_path_for(doc_root: Path, corpus: str) -> Path:
    metanorma_dir = doc_root if corpus == "clean" else doc_root / "metanorma"
    return (
        metanorma_dir / "document.html"
        if corpus == "clean"
        else doc_root / "verify" / "document.html"
    )


TABLE_DELIM_RE = re.compile(r"^\|={3,}\s*$")
TABLE_ATTR_RE = re.compile(r"^\[([^\]]*)\]\s*$")
COLSPAN_RE = re.compile(r"^\d+\+")


def _adoc_rows(block: str) -> list[list[str]]:
    """Positional rows: internal EMPTY cells must survive — they carry the
    grid structure (rowspan/colspan) the header merge depends on."""
    rows: list[list[str]] = []
    for line in block.splitlines():
        s = line.strip()
        if not s:
            continue
        parts = s.split("|")
        if len(parts) > 1 and parts[0].strip() == "":
            parts = parts[1:]  # leading row marker
        cells = [COLSPAN_RE.sub("", c).strip() for c in parts]
        if any(cells):
            rows.append(cells)
    return rows


def _adoc_tables_from_text(text: str, anchor: str, title: str) -> list[TableExtract]:
    """AsciiDoc |=== tables. The SOURCE is the authority: options="header"
    declares the header explicitly (no heuristic), cell values are pre-OCR
    (the verify HTML renders them mangled)."""
    lines = text.splitlines()
    tables: list[TableExtract] = []
    i = 0
    while i < len(lines):
        if not TABLE_DELIM_RE.match(lines[i]):
            i += 1
            continue
        # attr lines ([cols=...], [options="header"]) PRECEDE the delimiter
        has_header = False
        j = i - 1
        while j >= 0 and TABLE_ATTR_RE.match(lines[j].strip()):
            if "header" in lines[j]:
                has_header = True
            j -= 1
        i += 1
        block: list[str] = []
        while i < len(lines) and not TABLE_DELIM_RE.match(lines[i]):
            block.append(lines[i])
            i += 1
        i += 1  # closing delim
        rows = _adoc_rows("\n".join(block))
        if len(rows) < 2:
            continue
        header_cells: list[str] = []
        if has_header:
            width = max(len(r) for r in rows)
            first = rows.pop(0)
            first += [""] * (width - len(first))
            header_cells = first
            # rowspan-style continuation: rows whose first cells are empty
            # extend the header BY POSITION
            while rows and not rows[0][0].strip():
                cont = rows.pop(0)
                cont += [""] * (width - len(cont))
                header_cells = [
                    f"{h}, {c}".strip(", ") if c else h
                    for h, c in zip(header_cells, cont)
                ]
        if not header_cells and rows:
            header_cells = [f"Column {n + 1}" for n in range(max(len(r) for r in rows))]
        tables.append(TableExtract(
            clause_anchor=anchor, clause_title=title, caption="",
            columns=header_cells, rows=rows,
            header_heuristic=not has_header,
        ))
    return tables


def extract_doc_tables_adoc(sections_dir: Path, fallback_adoc: str | None, doc_root: Path, corpus: str) -> list[TableExtract]:
    """Section adocs first (real structure); document.html fallback."""
    tables: list[TableExtract] = []
    files = sorted(sections_dir.glob("*.adoc")) if sections_dir.is_dir() else []
    for f in files:
        raw = f.read_text(encoding="utf-8", errors="replace")
        tm = re.search(r"^={2,3}\s+(.+)$", raw, re.M)
        title = tm.group(1).strip() if tm else ""
        # the clause number in the HEADING is the citation anchor ("3.5"),
        # not the filename prefix ("35")
        tm_num = re.match(r"^(\d+(?:\.\d+)*)\.?\s", title)
        if tm_num:
            anchor = tm_num.group(1)
        else:
            fm = re.match(r"^(\d+(?:\.\d+)?)", f.stem)
            anchor = fm.group(1).rstrip(".") if fm else ""
        tables.extend(_adoc_tables_from_text(raw, anchor, title))
    if not tables and fallback_adoc:
        for i, part in enumerate(re.split(r"(?m)^==\s+", fallback_adoc)[1:], start=1):
            lines = part.split("\n", 1)
            title = lines[0].strip()
            m = re.match(r"^(\d+(?:\.\d+)*)\.?\s", title)
            tables.extend(_adoc_tables_from_text(lines[1] if len(lines) > 1 else "", m.group(1) if m else str(i), title))
    if not tables:
        path = html_path_for(doc_root, corpus)
        if path.is_file():
            try:
                tables = extract_doc_tables(path)
            except Exception:  # noqa: BLE001
                tables = []
    return tables


def _clean(cell: str) -> str:
    return strip_literal_tags(re.sub(r"\s+", " ", cell).strip())


def extract_doc_tables(html_path: Path) -> list[TableExtract]:
    soup = BeautifulSoup(html_path.read_text(encoding="utf-8", errors="replace"), "html.parser")
    for tag in soup(["script", "style", "nav"]):
        tag.decompose()
    body = soup.body or soup

    tables: list[TableExtract] = []
    cur_anchor, cur_title = "", ""
    table_no = 0
    for el in body.find_all([*HEADING_TAGS, "table"]):
        if el.find_parent("table"):
            continue
        if el.name in HEADING_TAGS:
            title = re.sub(r"\s+", " ", el.get_text(" ", strip=True))
            m = HEADING_NUM_RE.match(title)
            cur_anchor, cur_title = (m.group(1), title) if m else ("", title)
            continue
        table_no += 1
        cap_el = el.find("caption")
        caption = _clean(cap_el.get_text(" ", strip=True)) if cap_el else ""
        header_cells: list[str] = []
        body_rows: list[list[str]] = []
        thead = el.find("thead")
        if thead:
            for tr in thead.find_all("tr"):
                cells = [_clean(c.get_text(" ", strip=True)) for c in tr.find_all(["th", "td"])]
                if any(cells):
                    header_cells = [c for c in cells if c] or header_cells
        for tr in el.find_all("tr"):
            if thead and thead in tr.parents:
                continue
            cells = [_clean(c.get_text(" ", strip=True)) for c in tr.find_all(["th", "td"])]
            cells = [c for c in cells if c]
            if not cells:
                continue
            if not header_cells and tr.find("th"):
                header_cells = cells
            else:
                body_rows.append(cells)
        header_heuristic = False
        if not header_cells and body_rows:
            # no th/thead anywhere (OCR render): a fabricated header
            # mislabels normative facts — keep positional labels instead
            header_cells = [f"Column {i + 1}" for i in range(max(len(r) for r in body_rows))]
            header_heuristic = True
        if not body_rows:
            continue
        tables.append(TableExtract(
            clause_anchor=cur_anchor, clause_title=cur_title, caption=caption,
            columns=header_cells, rows=body_rows, header_heuristic=header_heuristic,
        ))
    return tables


def _embed_text(doc_ident: str, t: TableExtract) -> str:
    head = f"{t.caption}. " if t.caption else "Table. "
    loc = f"Source: {doc_ident}" + (f" §{t.clause_anchor}" if t.clause_anchor else "")
    title = re.sub(r"^\d+(?:\.\d+)*\.?\s*", "", t.clause_title) if t.clause_title else ""
    loc += f" {title}" if title and title != t.caption else ""
    cols = "; ".join(t.columns)
    lines = [f"{head}{loc}. Columns: {cols}."]
    for row in t.rows:
        pairs = "; ".join(f"{label} = {val}" for label, val in zip(t.columns, row) if val)
        lines.append(f"Row: {pairs or ' | '.join(row)}.")
    return "\n".join(lines)


def _display_text(t: TableExtract) -> str:
    width = max([len(c) for c in t.columns] + [len(c) for r in t.rows for c in r] + [3])
    def fmt(cells: list[str]) -> str:
        padded = [c.ljust(width) for c in cells]
        return "| " + " | ".join(padded) + " |"
    sep = "|-" + "-|-".join("-" * width for _ in t.columns) + "-|"
    out = []
    if t.caption:
        out.append(f"Table — {t.caption}")
    out.append(fmt(t.columns))
    out.append(sep)
    out.extend(fmt(r) for r in t.rows)
    return "\n".join(out)


def table_records(doc, tables: list[TableExtract]) -> list[dict]:
    ident = normalize_identifier(doc.docidentifier or f"OIML {doc.doctype} {doc.doc_number}")
    out: list[dict] = []
    for i, t in enumerate(tables):
        embed = _embed_text(ident, t)
        h = hashlib.sha1(f"{doc.doc_id}|table|{t.clause_anchor}|{i}|{hashlib.sha256(embed.encode()).hexdigest()[:12]}".encode()).hexdigest()[:16]
        out.append({
            "id": f"t{h}",
            "doc_id": doc.doc_id,
            "chunk_ref": f"{ident} §{t.clause_anchor}#table{i + 1}",
            "chunk_type": "table",
            "caption": t.caption,
            "columns": t.columns,
            "rows": t.rows,
            "header_heuristic": t.header_heuristic,
            "embed_text": embed,
            "display_text": _display_text(t),
            "metadata": {  # Vectorize-ready scalars only (arrays are not metadata)
                "doc_id": doc.doc_id,
                "docidentifier": ident,
                "doctype": doc.doctype,
                "doc_number": doc.doc_number,
                "edition": doc.edition,
                "language": doc.language,
                "clause_anchor": t.clause_anchor,
                "clause_title": t.clause_title,
                "tier": doc.tier,
                "corpus": doc.corpus,
                "status": doc.status,
                "superseded_by": doc.superseded_by,
                "chunk_type": "table",
                "caption": t.caption[:200],
                "text_ref": f"{doc.corpus}/{doc.slug}#{t.clause_anchor or 'table'}-table{i + 1}",
            },
        })
    return out


def run_tables(corpus: str | None = None, limit: int | None = None, sample: str = "r76") -> None:
    """Extract every table in the corpora to artifacts/table-chunks.jsonl."""
    docs = []
    for c in ([corpus] if corpus else ["clean", "dirty"]):
        docs.extend(load_corpus(c))
    docs, _dropped = apply_precedence(docs)
    docs = [d for d in docs if d.language in INGEST_LANGUAGES]
    if limit:
        docs = docs[:limit]

    root = Path(__file__).resolve().parent.parent / "artifacts"
    root.mkdir(exist_ok=True)
    out_path = root / "table-chunks.jsonl"

    n_tables = n_docs = n_heuristic = 0
    samples: list[str] = []
    with out_path.open("w", encoding="utf-8") as fh:
        for doc in docs:
            doc_root = (CLEAN_DIR if doc.corpus == "clean" else DIRTY_DIR) / doc.slug.split("/")[0]
            metanorma_dir = doc_root if doc.corpus == "clean" else doc_root / "metanorma"
            adoc_path = metanorma_dir / "document.adoc"
            if not adoc_path.is_file():
                continue
            try:
                tables = extract_doc_tables_adoc(
                    metanorma_dir / "sections",
                    adoc_path.read_text(encoding="utf-8", errors="replace"),
                    doc_root,
                    doc.corpus,
                )
            except Exception as e:  # noqa: BLE001
                print(f"  ! tables error {doc.slug}: {e}")
                continue
            if not tables:
                continue
            n_docs += 1
            for rec in table_records(doc, tables):
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                n_tables += 1
                n_heuristic += rec["header_heuristic"]
                if sample in doc.slug and len(samples) < 2 and rec["caption"]:
                    samples.append(rec["embed_text"])

    print(f"tables: {n_tables} from {n_docs} docs ({n_heuristic} with heuristic header) -> {out_path}")
    for s in samples:
        print("--- sample ---")
        print(s[:600])
