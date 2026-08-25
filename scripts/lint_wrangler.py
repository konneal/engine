#!/usr/bin/env python3
"""CI lint: the public worker must never reference internal-tier resources.

Fails if workers/worker_public config or source mentions the internal
Vectorize index, internal buckets, or internal bindings. The public
worker's isolation is structural — this check guards against regressions.

Exception: the INTERNAL_SERVICE service binding to rag-internal is the
sanctioned federation path (retrieval-only, auth enforced inside the
internal worker; rag-public holds no Vectorize/bucket binding). Only that
binding declaration and the gateway module that owns it may name
rag-internal — anything else still fails.
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

# the one sanctioned reference: the service-binding declaration and the
# comments documenting it
ALLOWED_BINDING = re.compile(
    r'^\s*(#\s*service binding[^\n]*|service\s*=\s*"rag-internal"[^\n]*)$',
    re.I | re.M,
)
GATEWAY = Path("workers/worker_public/src/internal_gateway.ts")


def main() -> int:
    failures = []
    for target in TARGETS:
        if not target.exists():
            continue
        text = target.read_text(encoding="utf-8")
        if target.name == "wrangler.toml":
            text = ALLOWED_BINDING.sub("", text)
        for pattern in FORBIDDEN:
            if target == GATEWAY and pattern == r"rag-internal":
                continue  # owns the sanctioned service binding
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
