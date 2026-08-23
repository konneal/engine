from __future__ import annotations

import hashlib

from .config import MAX_CHUNK_CHARS
from .models import Chunk, DocRecord


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


def chunk_doc(doc: DocRecord) -> list[Chunk]:
    chunks: list[Chunk] = []
    ident = doc.docidentifier or f"OIML {doc.doctype} {doc.doc_number}"
    header = f"{doc.title} — {ident}" + (f":{doc.edition}" if doc.edition else "") + f" ({doc.language})"
    for sec in doc.sections:
        sec_label = f"§{sec.anchor} {sec.title}".strip()
        body_header = f"{header}\n{sec_label}\n\n"
        for i, part in enumerate(split_long(sec.text)):
            text = (body_header + part).strip()
            cid = chunk_id_for(doc.doc_id, sec.anchor, i, part)
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
