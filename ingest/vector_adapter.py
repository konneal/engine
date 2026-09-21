"""Producer → Vectorize adapter: the single boundary where every chunk
acquires its vector-ready shape.

Why this exists (the 2026-09-02 incident postmortem): the lane builders
hand-rolled metadata per script, and nothing tied a chunk to its TARGET
index — so a lane chunk enriched through /admin/enrich's upsert side
effect entered the PRODUCTION index (1,126 lane vectors, cited in live
answers). Related symptoms of the same gap: corpus vocabulary drift
('primmel' vs 'exp_primmel', edition "2021" vs "2" between builds of
one lane), producer UUID anchors reaching citations (§_eb46a3a3-…),
and VECTOR_UPSERT_ERROR 40016/40017 metadata-size failures discovered
only at the wire.

The contract:

  - ChunkMetaModel — the wire schema, mirroring the serving contract
    (workers/shared/chunk.ts ChunkMeta; tests/chunkmeta.test.ts fails
    on drift). Scalars only (a Vectorize constraint), sizes validated
    BEFORE any wire call.
  - VectorChunk — id + text + metadata; `upsert(vector, target)` builds
    the REST payload, refusing corpora that do not belong to the target.
  - The corpus registry — the SSOT for every `corpus` value in any
    index. New corpora register HERE, never ad hoc in a script.

Producer projectors (primmel.py, mko.py, parse.py) keep their jobs —
they turn producer formats into dicts; THIS module is the exit door
those dicts must pass through to become vectors.
"""

from __future__ import annotations

import json
import re
from pathlib import Path as _Path
from typing import Literal

import yaml as _yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# ── the corpus registry ────────────────────────────────────────────────
# Declared in profile/corpora.yaml (the publisher profile — the single
# place a publisher's facts live; the TS wire schema reads the same file
# through profile.gen.ts). Production corpora are legal in the
# production index; lane corpora only in their comparison index.
_REGISTRY = _yaml.safe_load((_Path(__file__).resolve().parents[1] / "profile" / "corpora.yaml").read_text())
PRODUCTION_CORPORA = frozenset(_REGISTRY["production"])
LANE_CORPORA = frozenset(k for k in _REGISTRY["lanes"] if k != "glossary")
# the vocabulary lane: serving-side (the L2 nomenclature bridge), its own index
SERVING_LANE_CORPORA = frozenset({"glossary"}) & frozenset(k for k in _REGISTRY["lanes"])

MAX_META_BYTES = 9_000  # Vectorize hard limit is 10KB per vector metadata
MAX_TEXT_CHARS = 2_800  # the 40016 lesson (2026-08-31): cap chunk_text

# producer UUID anchors are never a citable clause reference — reject at
# BUILD time instead of hiding them at citation time (pipeline.ts garbage
# detection stays as defense in depth)
_UUID_ANCHOR = re.compile(r"^_?[0-9a-f]{8}-[0-9a-f]{4}-", re.I)

Target = Literal["production", "exp_plain", "exp_adoc", "exp_mko", "primmel", "primmel_flat", "exp_composed", "glossary"]

# which corpora may an index hold — the structural incident guard
TARGET_CORPORA: dict[str, frozenset[str]] = {
    "production": PRODUCTION_CORPORA,
    **{target: frozenset(corpora) for target, corpora in _REGISTRY["lanes"].items()},
}


class ChunkMetaModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    doc_id: str
    docidentifier: str
    doctype: str = ""
    doc_number: str = ""
    edition: str = ""
    language: str = "en"
    clause_anchor: str = ""
    clause_title: str = ""
    tier: str = ""
    corpus: str
    text_ref: str = ""
    status: str | None = None
    superseded_by: str | None = None
    unit_id: str | None = None
    block: str | None = None
    unit_hash: str | None = None
    producer: str | None = None
    source_lane: str | None = None
    linked_clause: str | None = None
    linked_document: str | None = None
    # document order as an integer (metanorma-document#56): producers
    # that carry it make reading order a sort, not an anchor parse
    ordinal: int | None = None
    # the model plane (retrieval-export derivation): the unit's own
    # versioning and identity, canonical per primmel/primmel-ts#65
    model_version: str | None = None
    model_node: str | None = None
    model_kind: str | None = None
    standard: str | None = None
    # the license entitlement key (the package's `license_key` facet, e.g.
    # `std:iec-60068-2-30`) — set ONLY when the chunk's content comes from
    # a licensed package; public content carries none. Serving's hard scope
    # (workers/worker_public/src/stages/licenseScope.ts) drops chunks whose
    # key is absent from the caller's entitlement set, before ranking.
    standard_key: str | None = None
    section_summary: str | None = None
    child_anchors: str | None = None
    ctx: str | None = None
    chunk_text: str | None = None

    @field_validator("corpus")
    @classmethod
    def _registered_corpus(cls, v: str) -> str:
        if v not in PRODUCTION_CORPORA | LANE_CORPORA | SERVING_LANE_CORPORA:
            raise ValueError(
                f"corpus {v!r} is not registered — add it to ingest/vector_adapter.py's registry, never emit it ad hoc"
            )
        return v

    @field_validator("clause_anchor")
    @classmethod
    def _no_uuid_anchor(cls, v: str) -> str:
        # MKO producer anchors are UUIDs when the clause number is
        # missing; serving already treats them as unciteable garbage —
        # strip at BUILD time so they can never reach a citation at all
        if v and _UUID_ANCHOR.search(v):
            return ""
        return v

    @field_validator("chunk_text")
    @classmethod
    def _cap_chunk_text(cls, v: str | None) -> str | None:
        if v is None:
            return v
        return v if len(v) <= MAX_TEXT_CHARS else v[: MAX_TEXT_CHARS - 1].rstrip() + " …"

    @model_validator(mode="after")
    def _wire_size(self) -> "ChunkMetaModel":
        # what actually ships: every field except chunk_text rides as
        # metadata alongside the (capped) chunk_text
        meta = self.model_dump(exclude={"chunk_text"}, exclude_none=True)
        size = len(json.dumps(meta).encode()) + (len(self.chunk_text.encode()) if self.chunk_text else 0)
        if size > MAX_META_BYTES:
            raise ValueError(f"serialized metadata is {size} bytes (cap {MAX_META_BYTES}) — shrink chunk_text/child_anchors before the wire")
        return self


class VectorChunk(BaseModel):
    id: str = Field(min_length=1)
    text: str
    metadata: ChunkMetaModel

    @field_validator("text")
    @classmethod
    def _cap_text(cls, v: str) -> str:
        return v if len(v) <= MAX_TEXT_CHARS else v[: MAX_TEXT_CHARS - 1].rstrip() + " …"

    def belongs_to(self, target: Target) -> bool:
        return self.metadata.corpus in TARGET_CORPORA[target]

    def upsert(self, vector: list[float], target: Target) -> dict:
        """The REST upsert payload — the ONLY way a chunk reaches an
        index, and it refuses corpora foreign to the target."""
        if not self.belongs_to(target):
            raise ValueError(
                f"chunk {self.id} corpus={self.metadata.corpus!r} does not belong to target {target!r} "
                f"(the 2026-09-02 incident class: lane corpora may never enter production)"
            )
        meta = self.metadata.model_dump(exclude_none=True)
        meta["chunk_text"] = self.text
        return {"id": self.id, "values": vector, "metadata": meta}


def wire_meta(md: dict) -> dict:
    """The declared projection from a producer's (rich) metadata dict to
    the Vectorize-legal wire metadata: scalar values or string arrays
    only (Vectorize law — API error 40017 otherwise). Rich producer
    payloads (e.g. metadata.table's columns/rows objects) are DERIVATION
    records, never wire state — serving reads rich payloads from D1
    unit_payloads. The 2026-09-10/11 restore incident: raw-jsonl
    consumers shipped the rich records and Vectorize rejected whole
    batches (40017 via REST, opaque 502 via the binding) — misread as
    throttling for a day. Every consumer of a chunk jsonl's metadata on
    the way to an index goes through HERE."""
    return {
        k: v
        for k, v in md.items()
        if isinstance(v, (str, int, float, bool))
        or v is None
        or (isinstance(v, list) and v and all(isinstance(x, str) for x in v))
    }


def normalize_chunk(raw: dict, *, target: Target) -> VectorChunk:
    """Adapt a projector's dict to a VectorChunk for a TARGET.

    Producer-specific remaps live here, not in calling scripts: the
    production MKO flow remaps corpus mko→oiml (+producer marker), the
    lane MKO flow keeps its exp_mko namespace."""
    md = dict(raw.get("metadata") or {})
    if target == "production" and md.get("corpus") == "mko":
        md["corpus"] = "oiml"
        md["tier"] = "curated"
        md["producer"] = md.get("producer", "mko")
    md = wire_meta(md)
    chunk = VectorChunk(id=raw["id"], text=raw.get("text", ""), metadata=ChunkMetaModel(**md))
    # fail fast on the incident class: a chunk foreign to its target
    # must not even ADAPT, let alone reach a wire call
    if not chunk.belongs_to(target):
        raise ValueError(
            f"chunk {chunk.id} corpus={chunk.metadata.corpus!r} does not belong to target {target!r} "
            f"(the 2026-09-02 incident class: lane corpora may never enter production)"
        )
    return chunk
