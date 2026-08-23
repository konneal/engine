#!/usr/bin/env python3
"""CI lint: the public worker must never reference internal-tier resources.

Fails if workers/worker_public config or source mentions the internal
Vectorize index, internal buckets, or internal bindings. The public
worker's isolation is structural — this check guards against regressions.
"""

import re
import sys
from pathlib import Path

FORBIDDEN = [
    r"idx_iso_internal",
    r"rag-internal",
    r"worker_internal",
    r"smartcab",
]

TARGETS = [
    Path("workers/worker_public/wrangler.toml"),
    *Path("workers/worker_public/src").glob("*.ts"),
]


def main() -> int:
    failures = []
    for target in TARGETS:
        if not target.exists():
            continue
        text = target.read_text(encoding="utf-8")
        for pattern in FORBIDDEN:
            if re.search(pattern, text, re.I):
                failures.append(f"{target}: matches forbidden pattern {pattern!r}")
    if failures:
        print("BINDING LINT FAILED — public worker references internal resources:")
        for f in failures:
            print(f"  {f}")
        return 1
    print(f"binding lint OK ({len(TARGETS)} files checked)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
