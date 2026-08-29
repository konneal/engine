"""MKO (Metanorma Knowledge Objects) ingestion — the producer-native path.

Reads an MKO bundle (MN 116: manifest.json + document.json + units.jsonl +
edges.jsonl + glossary.json) and projects it into the RAG record shapes:

  clause/annex units     → DocRecord.sections + clause chunks
  table units            → atomic table chunks carrying typed payloads
                           (never only linearized text)
  term units             → glossary lane + definition chunks
  formula units          → equation chunks (description/asciimath survive
                           retrieval)
  requirement units      → requirement chunks with ModSpec identifiers
  edges (part_of/cites/defines) → section-level D1 graph SQL

This replaces HTML scraping end to end: identifiers, status, and numbering
arrive typed from the producer instead of being re-derived. See
docs/REDESIGN-NORMATIVE-RAG-ETSI.md G-ETSI-2/3/5 — this is the reference
consumer the AI-serialization projection targets.

  .venv/bin/python scripts/ingest_mko.py <bundle.mko|bundle.mko.zip> …
"""

from __future__ import annotations

import hashlib
import json
import re
import zipfile
from pathlib import Path

from pydantic import BaseModel, Field

from .graph import esc, norm_id
from .models import Chunk, DocRecord, Section

STATUS_ABBR = {
    "published": "in-force",
    "active": "in-force",
    "in-force": "in-force",
    "IS": "in-force",
    "superseded": "superseded",
    "withdrawn": "withdrawn",
    "deleted": "withdrawn",
}
SUPERSEDED_BY_TYPES = {"obsoletedBy", "hasSuccessor", "succeededBy", "updates"}
CITES_TARGET_RE = re.compile(r"^ext:")

CHUNKED_UNIT_TYPES = {"clause", "annex", "term", "table", "formula",
                      "requirement", "sourcecode", "note", "example"}


class MkoManifestComponent(BaseModel):
    name: str
    file: str
    media_type: str
    count: int = 0
    hash: str = ""


class MkoManifest(BaseModel):
    model_config = {"populate_by_name": True}

    schema_id: str = Field(alias="schema")
    schema_version: str
    components: list[MkoManifestComponent] = Field(default_factory=list)


class MkoStatus(BaseModel):
    stage: str = ""
    substage: str = ""
    abbreviation: str = ""


class MkoTitle(BaseModel):
    lang: str = ""
    text: str = ""


class MkoDate(BaseModel):
    type: str = ""
    on: str = ""


class MkoRelation(BaseModel):
    type: str = ""
    to: str = ""


class MkoIds(BaseModel):
    canonical: str = ""
    short: str = ""
    docid: list[str] = Field(default_factory=list)
    urn: list[str] = Field(default_factory=list)


class MkoDocument(BaseModel):
    ids: MkoIds = MkoIds()
    flavor: str = ""
    doctype: str = ""
    titles: list[MkoTitle] = Field(default_factory=list)
    edition: str = ""
    languages: list[str] = Field(default_factory=list)
    status: MkoStatus = MkoStatus()
    dates: list[MkoDate] = Field(default_factory=list)
    relations: list[MkoRelation] = Field(default_factory=list)


class MkoUnit(BaseModel):
    id: str
    type: str
    anchor: str = ""
    number: str = ""
    title: str = ""
    parent: str = ""
    breadcrumb: list[str] = Field(default_factory=list)
    obligation: str = ""
    lang: str = ""
    text: str = ""
    payload: dict = Field(default_factory=dict)
    hash: str = ""


class MkoEdge(BaseModel):
    from_: str = Field(alias="from", default="")
    to: str = ""
    kind: str = ""

    model_config = {"populate_by_name": True}


class MkoGlossaryTerm(BaseModel):
    """Native Glossarist concept (glossary.json concepts[] entries)."""

    data: dict = Field(default_factory=dict)

    @property
    def concept(self) -> str:
        return self.data.get("id", "").removesuffix(f"-{self.language_code}")

    @property
    def language_code(self) -> str:
        return self.data.get("language_code", "eng")

    @property
    def designations(self) -> list[str]:
        return [t.get("designation", "") for t in self.data.get("terms", [])
                if t.get("designation")]

    @property
    def definition(self) -> str:
        parts = self.data.get("definition") or []
        return " ".join(p.get("content", "") for p in parts).strip()

    @property
    def sources(self) -> list[str]:
        out = []
        for s in self.data.get("sources", []):
            ref = ((s.get("origin") or {}).get("ref") or {}).get("source", "")
            if ref:
                out.append(ref)
        return out


class MkoGlossary(BaseModel):
    concepts: list[MkoGlossaryTerm] = Field(default_factory=list)


class MkoBundle:
    """One loaded MKO bundle (directory or zip); manifest hashes verified."""

    def __init__(self, path: Path):
        self.path = path
        if path.suffix == ".zip" or (path.is_file() and zipfile.is_zipfile(path)):
            with zipfile.ZipFile(path) as zf:
                self._files = {name: zf.read(name) for name in zf.namelist()}
        elif path.is_dir():
            self._files = {p.name: p.read_bytes() for p in path.iterdir() if p.is_file()}
        else:
            raise FileNotFoundError(f"not an MKO bundle: {path}")
        self.manifest = MkoManifest(**json.loads(self._text("manifest.json")))
        if self.manifest.schema_id != "metanorma-mko":
            raise ValueError(f"{path}: schema {self.manifest.schema_id!r} is not metanorma-mko")
        self._verify()
        self.document = MkoDocument(**json.loads(self._text("document.json")))
        self.units = [MkoUnit(**json.loads(line)) for line in self._lines("units.jsonl")]
        self.edges = [MkoEdge(**json.loads(line)) for line in self._lines("edges.jsonl")]
        self.glossary = MkoGlossary(**json.loads(self._text("glossary.json")))
        self.bibliography = [json.loads(line) for line in self._lines("bibliography.jsonl")] \
            if "bibliography.jsonl" in self._files else []
        self.units_by_id = {u.id: u for u in self.units}

    def _text(self, name: str) -> str:
        return self._files[name].decode("utf-8")

    def _lines(self, name: str) -> list[str]:
        return [ln for ln in self._text(name).splitlines() if ln.strip()]

    def _verify(self) -> None:
        for comp in self.manifest.components:
            if comp.file not in self._files:
                raise ValueError(f"{self.path}: manifest lists missing component {comp.file}")
            digest = hashlib.sha256(self._files[comp.file]).hexdigest()
            if comp.hash and not comp.hash.endswith(digest):
                raise ValueError(f"{self.path}: {comp.file} hash mismatch (manifest {comp.hash})")

    @property
    def canonical(self) -> str:
        return self.document.ids.canonical

    @property
    def slug(self) -> str:
        return self.document.ids.short or re.sub(r"[^A-Za-z0-9]+", "-", self.canonical).strip("-").lower()


def _doc_status(bundle: MkoBundle) -> tuple[str, str]:
    st = bundle.document.status
    abbr = st.abbreviation
    status = STATUS_ABBR.get(abbr, "unknown")
    if status == "unknown" and st.stage.startswith("60"):
        status = "in-force"  # ISO stage 60.x: published
    superseded_by = ""
    for rel in bundle.document.relations:
        if rel.type in SUPERSEDED_BY_TYPES:
            superseded_by = rel.to
            if status == "unknown":
                status = "superseded"
    return status, superseded_by


def _doctype(bundle: MkoBundle) -> str:
    # Flavor-typed (oiml "R", iso "international-standard") — pass through;
    # consumers filter on the raw vocabulary.
    return bundle.document.doctype


def to_doc_record(bundle: MkoBundle, corpus: str = "mko") -> DocRecord:
    doc = bundle.document
    status, superseded_by = _doc_status(bundle)
    title = next((t.text for t in doc.titles if not t.lang or t.lang.startswith("en")),
                 doc.titles[0].text if doc.titles else bundle.canonical)
    sections = [
        Section(anchor=u.number or u.anchor, title=u.title, text=u.text, source_file=u.anchor or u.id)
        for u in bundle.units
        if u.type in ("clause", "annex") and (u.text or u.title)
    ]
    return DocRecord(
        doc_id=f"{corpus}:{bundle.slug}",
        slug=bundle.slug,
        corpus=corpus,
        tier="mko",
        docidentifier=bundle.canonical,
        doctype=_doctype(bundle),
        edition=doc.edition,
        language=(doc.languages or ["en"])[0],
        title=title,
        word_count=sum(len(s.text.split()) for s in sections),
        status=status,
        superseded_by=superseded_by,
        sections=sections,
    )


def _unit_label(unit: MkoUnit, docidentifier: str) -> str:
    num = unit.number or unit.anchor
    title = unit.title or unit.payload.get("caption") or ""
    label = f"§{num} {title}".strip() if num else title
    return f"{docidentifier} {label}".strip()


def _unit_text(unit: MkoUnit) -> str:
    if unit.text:
        return unit.text
    p = unit.payload
    if unit.type == "table":
        cols = ", ".join(
            f"{c.get('label', '')}{' [' + c['unit'] + ']' if c.get('unit') else ''}"
            for c in p.get("columns", [])
        )
        head = f"Table: {p.get('caption', '')}; columns: {cols}" if cols else f"Table: {p.get('caption', '')}"
        return "\n".join([head] + [f"row: {r}" for r in p.get("rows", [])])
    if unit.type == "formula":
        return p.get("description") or p.get("asciimath") or p.get("mathml") or ""
    if unit.type == "term":
        defs = p.get("definition") or ""
        desig = ", ".join(p.get("designations", []))
        return f"{desig}: {defs}".strip(": ")
    if unit.type == "requirement":
        return p.get("statement") or unit.title or ""
    return unit.title


def _unit_chunk(bundle: MkoBundle, unit: MkoUnit, doc: DocRecord) -> Chunk | None:
    if unit.type not in CHUNKED_UNIT_TYPES:
        return None
    text = _unit_text(unit)
    if not text or len(text) < 15:
        return None
    header = f"{doc.title} — {doc.docidentifier} ({doc.language})\n\n"
    breadcrumb = " › ".join(unit.breadcrumb)
    crumb = f"{breadcrumb}\n\n" if breadcrumb else ""
    full = (header + crumb + _unit_label(unit, doc.docidentifier) + "\n\n" + text).strip()
    anchor = unit.number or unit.anchor or unit.id
    meta: dict = {
        "chunk_text": full[:2800],
        "doc_id": doc.doc_id,
        "docidentifier": doc.docidentifier,
        "doctype": doc.doctype,
        "doc_number": doc.doc_number,
        "edition": doc.edition,
        "language": doc.language,
        "clause_anchor": anchor,
        "clause_title": unit.title,
        "block": unit.type,
        "tier": doc.tier,
        "corpus": doc.corpus,
        "status": doc.status,
        "superseded_by": doc.superseded_by,
        "text_ref": f"{doc.corpus}/{doc.slug}#{unit.anchor or unit.id}",
        "unit_id": unit.id,
        "unit_hash": unit.hash,
    }
    if unit.type == "table":
        meta["table"] = unit.payload
    elif unit.type == "formula":
        meta["formula"] = unit.payload
    elif unit.type == "requirement":
        meta["requirement"] = unit.payload
    elif unit.type == "term":
        meta["term"] = unit.payload
    h = hashlib.sha1(f"{doc.doc_id}|{unit.id}|{unit.hash}".encode())
    return Chunk(
        id="c" + h.hexdigest()[:16],
        doc_id=doc.doc_id,
        chunk_ref=_unit_label(unit, doc.docidentifier),
        text=full,
        metadata=meta,
    )


def to_chunks(bundle: MkoBundle, doc: DocRecord) -> list[Chunk]:
    return [c for u in bundle.units if (c := _unit_chunk(bundle, u, doc))]


def to_glossary(bundle: MkoBundle, doc: DocRecord) -> list[dict]:
    return [
        {
            "doc_id": doc.doc_id,
            "docidentifier": doc.docidentifier,
            "concept": t.concept,
            "language_code": t.language_code,
            "designations": t.designations,
            "definition": t.definition,
            "sources": t.sources,
        }
        for t in bundle.glossary.concepts
    ]


def _biblio_node(bundle: "MkoBundle", citeas: str) -> str | None:
    """Preferred doc node id for a cited document: the native pubid
    rendering when the bibliography parsed one, else the raw citeas."""
    for entry in bundle.bibliography:
        if entry.get("citeas") == citeas and entry.get("pubid_render"):
            return _cite_node(entry["pubid_render"])
    return None


def to_bibliography(bundle: MkoBundle, doc: DocRecord) -> list[dict]:
    """Cited-document records: native Relaton item + native pubid parse,
    keyed to the reference unit — the resolvable objects behind cites
    edges."""
    return [
        {
            "doc_id": doc.doc_id,
            "docidentifier": doc.docidentifier,
            "unit": entry.get("unit"),
            "citeas": entry.get("citeas"),
            "pubid": entry.get("pubid"),
            "pubid_render": entry.get("pubid_render"),
            "bibitem": entry.get("bibitem"),
        }
        for entry in bundle.bibliography
    ]


def _cite_node(cited: str) -> str | None:
    """Node id for a cited document: OIML ids use the graph.py convention,
    anything else gets the same shape generically (doc:<SLUG>)."""
    node = norm_id(cited)
    if node:
        return node
    slug = re.sub(r"[^A-Za-z0-9]+", "-", cited).strip("-").upper()
    return f"doc:{slug}" if slug else None


TYPED_UNIT_FIELDS = ("table", "formula", "figure", "term", "requirement")


def _sq(x: str) -> str:
    return str(x).replace(chr(39), chr(39) * 2)


def to_payload_sql(bundle: "MkoBundle", doc: DocRecord) -> list[str]:
    """Typed unit payloads as D1 unit_payloads rows (answer contract v2):
    the worker resolves model [[u:<id>]] references against these — the
    payload data never passes through the LLM."""
    import json as _json

    rows: list[str] = []
    for u in bundle.units:
        if u.type not in TYPED_UNIT_FIELDS or not u.payload:
            continue
        # the lossless `mirror` renderer tree is fidelity/provenance, not a
        # serving form — strip it (SQLITE_TOOBIG on big tables otherwise);
        # the TS renderer consumes columns/rows, latex/description, alt/uri
        slim = {k: v for k, v in u.payload.items() if k != "mirror"}
        body = _json.dumps(slim, ensure_ascii=False)
        if len(body) > 60000:
            continue
        rows.append(
            "INSERT OR REPLACE INTO unit_payloads "
            "(unit_id, doc_id, docidentifier, edition, clause_anchor, type, payload) VALUES ("
            + ",".join([
                "'" + _sq(u.id) + "'",
                "'" + _sq(doc.doc_id) + "'",
                "'" + _sq(doc.docidentifier) + "'",
                "'" + _sq(doc.edition or "") + "'",
                "''",
                "'" + _sq(u.type) + "'",
                "'" + _sq(body) + "'",
            ])
            + ");\n"
        )
    return rows


def to_graph_sql(bundle: MkoBundle, doc: DocRecord) -> str:
    """Section-level graph fragment for D1 (graph_nodes/graph_edges).

    Emits G-ETSI-2/3 relations the HTML pipeline cannot: clause parthood,
    internal citation edges, and term→concept defines. Node ids follow the
    conventions of ingest/graph.py (doc:…, concept:…); section nodes are
    sec:<doc>:<anchor>. The documents registry stays owned by the relaton
    build — only nodes/edges tables are written here.
    """
    doc_node = norm_id(bundle.canonical)
    nodes: dict[str, str] = {}
    edges: set[tuple[str, str, str]] = set()

    def sec_node(unit: MkoUnit) -> str:
        anchor = unit.number or unit.anchor or unit.id
        nid = f"sec:{bundle.slug}:{anchor}"
        nodes.setdefault(nid, "section")
        return nid

    if doc_node:
        nodes.setdefault(doc_node, "doc")

    for unit in bundle.units:
        if unit.type in ("clause", "annex"):
            sn = sec_node(unit)
            if doc_node:
                edges.add((sn, doc_node, "part_of"))
        elif unit.type in ("table", "term", "formula", "requirement", "note",
                           "example", "sourcecode") and unit.parent:
            parent = bundle.units_by_id.get(unit.parent)
            if parent and parent.type in ("clause", "annex"):
                edges.add((sec_node(unit), sec_node(parent), "part_of"))

    for edge in bundle.edges:
        if edge.kind == "part_of":
            src = bundle.units_by_id.get(edge.from_)
            dst = bundle.units_by_id.get(edge.to)
            if src and dst:
                edges.add((sec_node(src), sec_node(dst), "part_of"))
        elif edge.kind == "defines":
            src = bundle.units_by_id.get(edge.from_)
            if src:
                concept = edge.to.removeprefix("concept:")
                nodes.setdefault(f"concept:{concept}", "concept")
                edges.add((sec_node(src), f"concept:{concept}", "defines"))
        elif edge.kind == "cites":
            src = bundle.units_by_id.get(edge.from_)
            raw = CITES_TARGET_RE.sub("", edge.to)
            target = _biblio_node(bundle, raw) or _cite_node(raw)
            if src and target and target != doc_node:
                nodes.setdefault(target, "doc")
                edges.add((sec_node(src), target, "cites"))

    # Cross-document relations from the bibliographic record, with the
    # Relaton relation type verbatim (obsoletes, hasSuccessor, hasPart,
    # updates, ...) — the G-ETSI-C edges between documents.
    if doc_node:
        for rel in bundle.document.relations:
            target = _cite_node(rel.to) if rel.to else None
            if target and target != doc_node and rel.type:
                nodes.setdefault(target, "doc")
                edges.add((doc_node, target, rel.type))

    out = []
    for nid, kind in nodes.items():
        out.append(f"INSERT OR IGNORE INTO graph_nodes (id, kind, label) VALUES ('{esc(nid)}', '{kind}', '{esc(nid)}');")
    for src, dst, kind in sorted(edges):
        out.append(f"INSERT OR IGNORE INTO graph_edges (src, dst, kind) VALUES ('{esc(src)}', '{esc(dst)}', '{kind}');")
    return "\n".join(out) + ("\n" if out else "")
