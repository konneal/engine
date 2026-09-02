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
    (workers/worker_public/src/pipeline.ts ChunkMeta). Scalars only
    (a Vectorize constraint), sizes validated BEFORE any wire call.
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
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# ── the corpus registry (SSOT) ─────────────────────────────────────────
# production corpora are legal in idx_oiml_public_v2; lane corpora only
# in their comparison index. smart-model is the model-plane projection.
PRODUCTION_CORPORA = frozenset({"oiml", "dirty", "clean", "synthetic", "smart-model"})
LANE_CORPORA = frozenset({"exp_plain", "exp_adoc", "exp_mko", "primmel", "primmel_flat", "exp_composed"})
# the vocabulary lane: serving-side (the L2 nomenclature bridge), its own index
SERVING_LANE_CORPORA = frozenset({"glossary"})

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
    "exp_plain": frozenset({"exp_plain"}),
    "exp_adoc": frozenset({"exp_adoc"}),
    "exp_mko": frozenset({"exp_mko"}),
    "primmel": frozenset({"primmel"}),
    # the ablation lane indexes the SAME primmel corpus, unlinked
    "primmel_flat": frozenset({"primmel"}),
    "exp_composed": frozenset({"exp_composed"}),
    # the vocabulary lane (L2 nomenclature bridge)
    "glossary": frozenset({"glossary"}),
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
    md = {k: v for k, v in md.items() if isinstance(v, (str, int, float, bool)) or v is None}
    chunk = VectorChunk(id=raw["id"], text=raw.get("text", ""), metadata=ChunkMetaModel(**md))
    # fail fast on the incident class: a chunk foreign to its target
    # must not even ADAPT, let alone reach a wire call
    if not chunk.belongs_to(target):
        raise ValueError(
            f"chunk {chunk.id} corpus={chunk.metadata.corpus!r} does not belong to target {target!r} "
            f"(the 2026-09-02 incident class: lane corpora may never enter production)"
        )
    return chunk
