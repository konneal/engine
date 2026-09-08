"""Ingest the smartcab-refs ISO/IEC corpus into idx_iso_internal.

The ISO corpus is internal-only (copyrighted, never public). This script
uses the same HTML-first extraction as the OIML pipeline, writing to a
separate chunks file for the internal index.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from bs4 import BeautifulSoup

ISO_DIR = Path.home() / "src/primmel/smartcab-refs/sources"
ARTIFACTS = Path(__file__).resolve().parents[1] / "artifacts"
ISO_CHUNKS = ARTIFACTS / "iso_chunks.jsonl"

LITERAL_TAG_RE = re.compile(r"</?[a-zA-Z][^<>]{0,120}>")
HEADING_NUM_RE = re.compile(r"^(\d+(?:\.\d+)*)\.?\s")


def strip_tags(text: str) -> str:
    return re.sub(r"\s{2,}", " ", LITERAL_TAG_RE.sub(" ", text)).strip()


def extract_iso_doc(doc_root: Path) -> list[dict]:
    """Extract chunks from a single ISO/IEC document."""
    adoc = doc_root / "sources" / "document.adoc"
    if not adoc.is_file():
        # some docs nest one level deeper: sources/{name-with-year}/document.adoc
        for sub in sorted((doc_root / "sources").iterdir()) if (doc_root / "sources").is_dir() else []:
            if (sub / "document.adoc").is_file():
                adoc = sub / "document.adoc"
                doc_root = sub.parent  # adjust for html/sections lookup
                break
        else:
            return []

    text = adoc.read_text(encoding="utf-8", errors="replace")
    # extract identifier from :docnumber: and publisher
    docnum = re.search(r"^:docnumber:\s*(.+)$", text, re.M)
    publisher = re.search(r"^:publisher:\s*(.+)$", text, re.M)
    title = ""
    for line in text.splitlines():
        if line.startswith("= "):
            title = line[2:].strip()
            break
    title_main = re.search(r"^:title-main-en:\s*(.+)$", text, re.M)

    docnumber = (docnum.group(1).strip() if docnum else doc_root.name.replace("iso-iec-", "ISO/IEC ").replace("iso-", "ISO "))
    pub = (publisher.group(1).strip() if publisher else "ISO")
    ident = f"{pub} {docnumber}" if "IEC" not in pub else f"ISO/IEC {docnumber}"
    doc_title = (title_main.group(1).strip() if title_main else title) or ident

    # try HTML first (compiled), fall back to sections dir
    html_path = doc_root / "sources" / "document.html"
    sections_dir = doc_root / "sources" / "sections"

    chunks = []

    # overview chunk
    overview = f"{doc_title} — {ident}. An ISO/IEC standard for conformity assessment (CASCO)."
    chunks.append({
        "id": f"iso-{doc_root.name}-overview",
        "doc_id": f"iso:{doc_root.name}",
        "chunk_ref": f"{ident} §overview",
        "text": overview,
        "metadata": {
            "chunk_text": overview[:2800],
            "doc_id": f"iso:{doc_root.name}",
            "docidentifier": ident,
            "doctype": "ISO",
            "doc_number": docnumber,
            "edition": "",
            "language": "en",
            "clause_anchor": "overview",
            "clause_title": "Document overview",
            "tier": "curated",
            "corpus": "iso-internal",
            "status": "in-force",
            "superseded_by": "",
            "text_ref": f"iso-internal/{doc_root.name}#overview",
        },
    })

    if html_path.is_file():
        soup = BeautifulSoup(html_path.read_text(encoding="utf-8", errors="replace"), "html.parser")
        for tag in soup(["script", "style", "nav"]):
            tag.decompose()
        body = soup.body or soup
        cur_anchor, cur_title = "", ""
        buf: list[str] = []
        for el in body.find_all(["h2", "h3", "h4", "p", "li", "table"]):
            if el.name in ("h2", "h3", "h4"):
                if buf:
                    chunks.extend(_flush(ident, doc_root.name, cur_anchor, cur_title, buf))
                t = el.get_text(" ", strip=True)
                m = HEADING_NUM_RE.match(t)
                cur_anchor = m.group(1) if m else ""
                cur_title = t
                buf = []
            elif el.name == "table":
                rows = []
                for tr in el.find_all("tr"):
                    cells = [strip_tags(c.get_text(" ", strip=True)) for c in tr.find_all(["th", "td"])]
                    cells = [c for c in cells if c]
                    if cells:
                        rows.append(" | ".join(cells))
                if rows:
                    buf.extend(rows)
            else:
                t = strip_tags(el.get_text(" ", strip=True))
                if t:
                    buf.append(f"- {t}" if el.name == "li" else t)
        if buf:
            chunks.extend(_flush(ident, doc_root.name, cur_anchor, cur_title, buf))
    elif sections_dir.is_dir():
        for f in sorted(sections_dir.glob("*.adoc")):
            sec_text = f.read_text(encoding="utf-8", errors="replace")
            anchor = ""
            m = re.match(r"^(\d+)", f.stem)
            if m:
                anchor = str(int(m.group(1)))
            tm = re.search(r"^==\s+(.+)$", sec_text, re.M)
            title = tm.group(1).strip() if tm else f.name
            body = strip_tags(sec_text)
            if body:
                chunks.extend(_flush(ident, doc_root.name, anchor, title, [body]))

    return chunks


def _flush(ident: str, doc_name: str, anchor: str, title: str, buf: list[str]) -> list[dict]:
    text = "\n".join(b for b in buf if b).strip()
    if not text or len(text) < 30:
        return []
    header = f"{title or 'Clause'} — {ident}\n\n"
    full = header + text
    return [{
        "id": f"iso-{doc_name}-{anchor or title[:20].replace(' ', '-')}-{hash(full) % 99999}",
        "doc_id": f"iso:{doc_name}",
        "chunk_ref": f"{ident} §{anchor}" if anchor else ident,
        "text": full,
        "metadata": {
            "chunk_text": full[:2800],
            "doc_id": f"iso:{doc_name}",
            "docidentifier": ident,
            "doctype": "ISO",
            "doc_number": "",
            "edition": "",
            "language": "en",
            "clause_anchor": anchor,
            "clause_title": title,
            "tier": "curated",
            "corpus": "iso-internal",
            "status": "in-force",
            "superseded_by": "",
            "text_ref": f"iso-internal/{doc_name}#{anchor or 'body'}",
        },
    }]


def main() -> None:
    ISO_CHUNKS.parent.mkdir(exist_ok=True)
    all_chunks = []
    for doc_dir in sorted(ISO_DIR.iterdir()):
        if not doc_dir.is_dir() or doc_dir.name.startswith("."):
            continue
        chunks = extract_iso_doc(doc_dir)
        print(f"  {doc_dir.name}: {len(chunks)} chunks")
        all_chunks.extend(chunks)
    with ISO_CHUNKS.open("w", encoding="utf-8") as f:
        for c in all_chunks:
            f.write(json.dumps(c) + "\n")
    print(f"wrote {ISO_CHUNKS} ({len(all_chunks)} chunks from {len(list(ISO_DIR.iterdir()))} docs)")


if __name__ == "__main__":
    main()
