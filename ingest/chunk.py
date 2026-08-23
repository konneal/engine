from __future__ import annotations

import hashlib

from .config import MAX_CHUNK_CHARS
from .models import Chunk, DocRecord
from .parse import normalize_identifier


def chunk_id_for(doc_id: str, anchor: str, idx: int, body: str) -> str:
    h = hashlib.sha1(f"{doc_id}|{anchor}|{idx}|{hashlib.sha256(body.encode()).hexdigest()[:12]}".encode())
    return "c" + h.hexdigest()[:16]


def split_long(text: str, max_chars: int = MAX_CHUNK_CHARS) -> list[str]:
    if len(text) <= max_chars:
        return [text]
    paras = text.split("\n\n")
    parts: list[str] = []
    cur = ""
    for p in paras:
        if cur and len(cur) + len(p) + 2 > max_chars:
            parts.append(cur.strip())
            cur = p
        else:
            cur = f"{cur}\n\n{p}" if cur else p
    if cur.strip():
        parts.append(cur.strip())
    # pathological single paragraph > max: hard split
    out: list[str] = []
    for p in parts:
        while len(p) > max_chars:
            out.append(p[:max_chars])
            p = p[max_chars:]
        if p:
            out.append(p)
    return out


DOCTYPE_NAMES = {
    "R": "International Recommendation — a model regulation establishing the metrological characteristics required of certain measuring instruments",
    "D": "International Document — informative guidance developing the principles established by Recommendations",
    "B": "International Basic Publication — the operational framework documents of the OIML and its systems",
    "G": "International Guide — guidance on specific legal metrology topics",
    "E": "OIML Expert Report — technical reports by appointed experts",
}


def _ident_label(doc: DocRecord) -> str:
    ident = doc.docidentifier or f"OIML {doc.doctype} {doc.doc_number}"
    label = f"{ident} ({doc.language})"
    return label


def _overview_chunk(doc: DocRecord, ident: str) -> Chunk:
    """Document-level chunk so 'What is R 60?' retrieves an overview, not a
    random clause."""
    plain = normalize_identifier(doc.docidentifier or f"OIML {doc.doctype} {doc.doc_number}")
    parts = [f"{doc.title} — {ident}."]
    if doc.doctype in DOCTYPE_NAMES:
        parts.append(f"An OIML {DOCTYPE_NAMES[doc.doctype]}.")
    overview = [
        s for s in doc.sections
        if s.title.lower().startswith(("scope", "introduction", "foreword", "abstract", "field of application"))
    ]
    for s in overview[:3]:
        parts.append(f"{s.title}: {s.text[:900]}")
    text = "\n\n".join(parts)
    return Chunk(
        id=chunk_id_for(doc.doc_id, "overview", 0, text),
        doc_id=doc.doc_id,
        chunk_ref=f"{plain} §overview",
        text=text,
        metadata={
            "chunk_text": text[:2800],
            "doc_id": doc.doc_id,
            "docidentifier": plain,
            "doctype": doc.doctype,
            "doc_number": doc.doc_number,
            "edition": doc.edition,
            "language": doc.language,
            "clause_anchor": "overview",
            "clause_title": "Document overview",
            "tier": doc.tier,
            "corpus": doc.corpus,
            "text_ref": f"{doc.corpus}/{doc.slug}#overview",
        },
    )


def chunk_doc(doc: DocRecord) -> list[Chunk]:
    chunks: list[Chunk] = [_overview_chunk(doc, _ident_label(doc))]
    header = f"{doc.title} — {_ident_label(doc)}\n\n"
    for sec in doc.sections:
        sec_label = (f"§{sec.anchor} " if sec.anchor else "") + (f"{sec.title}\n\n" if sec.title else "")
        for i, part in enumerate(split_long(sec.text)):
            text = (header + sec_label + part).strip()
            cid = chunk_id_for(doc.doc_id, sec.anchor, i, part)
            ident = normalize_identifier(doc.docidentifier or f"OIML {doc.doctype} {doc.doc_number}")
            chunks.append(
                Chunk(
                    id=cid,
                    doc_id=doc.doc_id,
                    chunk_ref=f"{ident} §{sec.anchor}" + (f"#{i}" if i else ""),
                    text=text,
                    metadata={
                        "chunk_text": text,
                        "doc_id": doc.doc_id,
                        "docidentifier": ident,
                        "doctype": doc.doctype,
                        "doc_number": doc.doc_number,
                        "edition": doc.edition,
                        "language": doc.language,
                        "clause_anchor": sec.anchor,
                        "clause_title": sec.title,
                        "tier": doc.tier,
                        "corpus": doc.corpus,
                        "text_ref": f"{doc.corpus}/{doc.slug}#{sec.source_file}",
                    },
                )
            )
    return chunks


def doc_content_hash(chunks: list[Chunk]) -> str:
    h = hashlib.sha256()
    for c in sorted(chunks, key=lambda x: x.id):
        h.update(c.id.encode())
        h.update(hashlib.sha256(c.text.encode()).digest())
    return h.hexdigest()
