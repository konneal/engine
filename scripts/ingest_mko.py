"""Ingest MKO bundles end to end (producer-native path, mn #592).

  .venv/bin/python scripts/ingest_mko.py <bundle.mko | bundle.mko.zip> […]

Reads each Metanorma Knowledge Objects bundle and writes, alongside the
existing artifact formats:

  artifacts/mko_chunks.jsonl   — chunks in the same shape ingest.cli parse
                                 emits (typed table/formula/term/requirement
                                 payloads in metadata)
  artifacts/mko_glossary.json  — glossary lane records
  artifacts/mko_graph.sql      — section-level D1 graph fragments
                                 (part_of / cites / defines)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ingest.mko import (  # noqa: E402
    MkoBundle,
    to_chunks,
    to_doc_record,
    to_glossary,
    to_graph_sql,
)

ARTIFACTS = Path(__file__).resolve().parents[1] / "artifacts"


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    ARTIFACTS.mkdir(exist_ok=True)
    all_chunks: list[dict] = []
    all_glossary: list[dict] = []
    graph_fragments: list[str] = []

    for raw in argv:
        bundle_path = Path(raw).expanduser()
        bundle = MkoBundle(bundle_path)
        doc = to_doc_record(bundle)
        chunks = to_chunks(bundle, doc)
        glossary = to_glossary(bundle, doc)
        graph_sql = to_graph_sql(bundle, doc)
        all_chunks.extend(c.model_dump() for c in chunks)
        all_glossary.extend(glossary)
        graph_fragments.append(graph_sql)
        by_type: dict[str, int] = {}
        for u in bundle.units:
            by_type[u.type] = by_type.get(u.type, 0) + 1
        types = ", ".join(f"{k}={v}" for k, v in sorted(by_type.items()))
        print(f"  {bundle.slug}: {len(bundle.units)} units ({types}) -> "
              f"{len(chunks)} chunks, {len(glossary)} terms, "
              f"{graph_sql.count(chr(10))} graph rows")

    chunks_out = ARTIFACTS / "mko_chunks.jsonl"
    with chunks_out.open("w", encoding="utf-8") as f:
        for c in all_chunks:
            f.write(json.dumps(c) + "\n")
    glossary_out = ARTIFACTS / "mko_glossary.json"
    glossary_out.write_text(json.dumps(all_glossary, ensure_ascii=False, indent=1), encoding="utf-8")
    graph_out = ARTIFACTS / "mko_graph.sql"
    graph_out.write_text("".join(graph_fragments), encoding="utf-8")
    print(f"wrote {chunks_out} ({len(all_chunks)} chunks), "
          f"{glossary_out} ({len(all_glossary)} terms), {graph_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
