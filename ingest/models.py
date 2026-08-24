from __future__ import annotations

from pydantic import BaseModel, Field


class Section(BaseModel):
    anchor: str = ""
    title: str = ""
    text: str = ""
    source_file: str = ""


class DocRecord(BaseModel):
    doc_id: str
    slug: str
    corpus: str
    tier: str
    docidentifier: str = ""
    doctype: str = ""
    doc_number: str = ""
    edition: str = ""
    language: str = "en"
    title: str = ""
    word_count: int = 0
    status: str = "unknown"
    superseded_by: str = ""
    family_members: list[str] = Field(default_factory=list)
    sections: list[Section] = Field(default_factory=list)

    @property
    def dedup_key(self) -> tuple[str, str, str, str]:
        return (self.doctype, self.doc_number, self.edition, self.language)


class Chunk(BaseModel):
    id: str
    doc_id: str
    chunk_ref: str
    text: str
    metadata: dict


class ManifestEntry(BaseModel):
    doc_id: str
    chunk_count: int
    content_hash: str
    tier: str
    corpus: str
