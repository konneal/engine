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
    to_bibliography,
    to_chunks,
    to_doc_record,
    to_glossary,
    to_graph_sql,
    to_payload_sql,
)
from ingest.langid import check_doc_language, load_exclusions, normalize_language  # noqa: E402
from ingest.config import INGEST_LANGUAGES  # noqa: E402

ARTIFACTS = Path(__file__).resolve().parents[1] / "artifacts"


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    ARTIFACTS.mkdir(exist_ok=True)
    all_chunks: list[dict] = []
    all_glossary: list[dict] = []
    all_bibliography: list[dict] = []
    graph_fragments: list[str] = []
    payload_rows: list[str] = []

    # per-doc resilience (TODO.remaining/11): one broken bundle (manifest
    # mismatch, drifted export) must not abort the whole run — the bundle is
    # skipped, named in the report, and the exit code still signals it so
    # the gated pipeline fails loudly. Resilience is throughput, never a
    # way to hide defects.
    skipped: list[tuple[str, str]] = []
    exclusions = load_exclusions()
    for raw in argv:
        bundle_path = Path(raw).expanduser()
        try:
            bundle = MkoBundle(bundle_path)
            doc = to_doc_record(bundle)
            # EN-only gate (issue #72): verify the bundle's language against
            # its content; a confident non-EN verdict excludes the edition
            check = check_doc_language(doc, exclusions)
            declared = normalize_language(doc.language)
            if check.excluded or declared not in INGEST_LANGUAGES:
                origin = "exclusion list" if check.listed else "DETECTED — record it in ingest/corpus-exclusions.yaml"
                detail = (f"declared {check.declared}, detected {check.detected} [{origin}] {check.evidence}"
                          if check.excluded else f"declared {doc.language} (not in INGEST_LANGUAGES)")
                print(f"  [ingest] EXCLUDED (non-EN) {bundle.slug}: {detail}", flush=True)
                continue
            chunks = to_chunks(bundle, doc)
            glossary = to_glossary(bundle, doc)
            bibliography = to_bibliography(bundle, doc)
            graph_sql = to_graph_sql(bundle, doc)
            payload_rows.extend(to_payload_sql(bundle, doc))
            all_chunks.extend(c.model_dump() for c in chunks)
            all_glossary.extend(glossary)
            all_bibliography.extend(bibliography)
            graph_fragments.append(graph_sql)
        except Exception as e:  # noqa: BLE001 — name it, skip it, report it
            skipped.append((bundle_path.name, str(e)[:160]))
            print(f"  [ingest] SKIP {bundle_path.name}: {str(e)[:160]}", flush=True)
    if skipped:
        (ARTIFACTS / "mko_skipped.json").write_text(
            __import__("json").dumps(skipped, indent=1), encoding="utf-8"
        )
        by_type: dict[str, int] = {}
        for u in bundle.units:
            by_type[u.type] = by_type.get(u.type, 0) + 1
        types = ", ".join(f"{k}={v}" for k, v in sorted(by_type.items()))
        print(f"  {bundle.slug}: {len(bundle.units)} units ({types}) -> "
              f"{len(chunks)} chunks, {len(glossary)} terms, "
              f"{len(bibliography)} cited docs, "
              f"{graph_sql.count(chr(10))} graph rows")

    # Incremental diff by unit content hash (MN 116 stable ids): only
    # new/changed units need embedding on re-ingest.
    chunks_out = ARTIFACTS / "mko_chunks.jsonl"
    changed_out = ARTIFACTS / "mko_changed.jsonl"
    prev = {}
    if chunks_out.exists():
        for line in chunks_out.read_text(encoding="utf-8").splitlines():
            if line.strip():
                c = json.loads(line)
                prev[(c["doc_id"], c["metadata"].get("unit_id"))] = c["metadata"].get("unit_hash")
    changed = []
    seen = set()
    for c in all_chunks:
        key = (c["doc_id"], c["metadata"].get("unit_id"))
        seen.add(key)
        if prev.get(key) != c["metadata"].get("unit_hash"):
            changed.append(c)
    removed = sum(1 for k in prev if k not in seen)
    print(f"diff: {len(changed)} new/changed, "
          f"{len(all_chunks) - len(changed)} unchanged, {removed} removed")
    with changed_out.open("w", encoding="utf-8") as f:
        for c in changed:
            f.write(json.dumps(c) + "\n")
    with chunks_out.open("w", encoding="utf-8") as f:
        for c in all_chunks:
            f.write(json.dumps(c) + "\n")
    glossary_out = ARTIFACTS / "mko_glossary.json"
    glossary_out.write_text(json.dumps(all_glossary, ensure_ascii=False, indent=1), encoding="utf-8")
    biblio_out = ARTIFACTS / "mko_bibliography.json"
    biblio_out.write_text(json.dumps(all_bibliography, ensure_ascii=False, indent=1), encoding="utf-8")
    graph_out = ARTIFACTS / "mko_graph.sql"
    graph_out.write_text("".join(graph_fragments), encoding="utf-8")
    payloads_out = ARTIFACTS / "mko_unit_payloads.sql"
    payloads_out.write_text("".join(payload_rows), encoding="utf-8")
    print(f"wrote {payloads_out} ({len(payload_rows)} typed units)")
    print(f"wrote {chunks_out} ({len(all_chunks)} chunks), "
          f"{glossary_out} ({len(all_glossary)} terms), "
          f"{biblio_out} ({len(all_bibliography)} cited docs), {graph_out}")
    return 3 if skipped else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
