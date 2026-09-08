#!/usr/bin/env python3
"""One-off: re-upsert v2 vectors with normalized docidentifier metadata.

The dirty corpus carries identifiers like "OIML R 60-1:2017 (E)" (year and
language marker embedded). Normalize to the stable publication identity
("OIML R 60-1") so retrieval-side grouping and citation display are clean.
Chunk ids, texts and embeddings are unchanged — only metadata is rewritten.
"""

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ingest.cf import CF  # noqa: E402
from ingest.config import ARTIFACTS  # noqa: E402
import os  # noqa: E402

YEAR_LANG_RE = re.compile(r"\s*:\s*(19|20)\d{2}\s*(\([A-Z/]+\))?\s*$")


def normalize(ident: str) -> str:
    out = ident.strip()
    for _ in range(2):  # some identifiers carry year twice
        out = YEAR_LANG_RE.sub("", out)
    return re.sub(r"\s+", " ", out).strip()


def main() -> None:
    if os.environ.get("VECTORIZE_INDEX") != "idx_oiml_public_v2":
        raise SystemExit("Set VECTORIZE_INDEX=idx_oiml_public_v2 (refuses to touch other indexes)")
    chunks = {json.loads(l)["id"]: json.loads(l) for l in (ARTIFACTS / "chunks.jsonl").open(encoding="utf-8")}
    vectors = []
    changed = 0
    with (ARTIFACTS / "embeddings.jsonl").open(encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            c = chunks.get(rec["id"])
            if not c:
                continue
            md = dict(c["metadata"])
            new_ident = normalize(md.get("docidentifier", ""))
            if new_ident != md.get("docidentifier"):
                md["docidentifier"] = new_ident
                changed += 1
            vectors.append({"id": rec["id"], "values": rec["values"], "metadata": md})
    print(f"re-upserting {len(vectors)} vectors, {changed} identifiers normalized")
    CF().vectorize_upsert(vectors)
    print("done")


if __name__ == "__main__":
    main()
