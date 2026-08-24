"""Delete index vectors whose ids are no longer in chunks.jsonl.

One-shot companion to the delta re-embed: after extraction fixes, old
chunk ids (stale text/metadata) must leave the index or they keep
surfacing in results alongside their replacements.

Usage:
    VECTORIZE_INDEX=idx_oiml_public_v2 .venv/bin/python scripts/delete_orphans.py [--dry-run]
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ingest.cf import CF  # noqa: E402
from ingest.cli import CHUNKS_PATH, EMBED_PATH  # noqa: E402


def main() -> None:
    if os.environ.get("VECTORIZE_INDEX") != "idx_oiml_public_v2":
        sys.exit("refusing to run: set VECTORIZE_INDEX=idx_oiml_public_v2")
    dry = "--dry-run" in sys.argv

    current = set()
    with CHUNKS_PATH.open(encoding="utf-8") as f:
        for line in f:
            current.add(json.loads(line)["id"])
    embedded = set()
    with EMBED_PATH.open(encoding="utf-8") as f:
        for line in f:
            embedded.add(json.loads(line)["id"])
    orphans = sorted(embedded - current)
    print(f"current {len(current)} / embedded {len(embedded)} / orphans {len(orphans)}")
    if not orphans or dry:
        return

    CF().vectorize_delete(orphans)
    print("done")


if __name__ == "__main__":
    main()
