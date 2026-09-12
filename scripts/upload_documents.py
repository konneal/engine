#!/usr/bin/env python3
"""Rendered-publication upload (metanorma-mirror layer 1, TODO.impl/73).

Uploads the clean corpus's own Metanorma HTML renderings to R2 under
docs/<slug>.html together with a clause-anchor map docs/<slug>.anchors.json
(clause number → heading anchor id), so a citation's clause can become a
deep link into the original document. Public OIML documents only — the
ISO/IEC internal corpus is never rendered to a public bucket (copyright;
same rule as every public R2 object).

Usage:
    .venv/bin/python scripts/upload_documents.py [--apply]

Without --apply: report only (which sources render, which anchors map).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ingest.config import ACCOUNT_ID  # noqa: E402

CLEAN_SOURCES = Path(os.environ.get("OIML_CLEAN_DIR", str(Path.home() / "src/mn/mn-samples-oiml/sources")))
WORKER_DIR = Path(__file__).resolve().parents[1] / "workers/worker_public"
BUCKET = "rag-public-assets"
SKIP_DIRS = {"verify", "oimlsmart-extract", "r060-images"}

CLAUSE = re.compile(r"^(\d+(?:\.\d+){0,4})\b")
ANNEX = re.compile(r"^Annex\s+([A-Z])\b")


class HeadingMap(HTMLParser):
    """Collects (clause number → element id) from heading tags: Metanorma
    HTML carries UUID ids; the clause number is the heading text's head."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.anchors: dict[str, str] = {}
        self._id: str | None = None
        self._buf: list[str] = []
        self._in_heading = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"h1", "h2", "h3", "h4"}:
            self._in_heading = True
            self._buf = []
            self._id = next((v for k, v in attrs if k == "id" and v), None)

    def handle_data(self, data: str) -> None:
        if self._in_heading:
            self._buf.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag in {"h1", "h2", "h3", "h4"} and self._in_heading:
            text = " ".join("".join(self._buf).split())
            m = CLAUSE.match(text) or ANNEX.match(text)
            if m and self._id and m.group(1) not in self.anchors:
                self.anchors[m.group(1)] = self._id
            self._in_heading = False
            self._id = None


def doc_slug(html: str) -> tuple[str, str]:
    """(slug, docidentifier) from the rendered cover. The docidentifier is
    preferred — its slug matches the citation doc_id's suffix exactly
    (mko:oiml-r60-2 → oiml-r60-2), so no mapping layer exists."""
    d = re.search(r"reference\s+(OIML\s+(?:R|D|B|G|E)\s*[\d]+(?:-[\d]+)?):\d{4}", html[:60000]) or re.search(
        r"(OIML\s+(?:R|D|B|G|E)\s*[\d]+(?:-[\d]+)?):\d{4}", html[:60000]
    )
    ident = d.group(1) if d else ""
    if not ident:
        t = re.search(r"<title>([^<]+)</title>", html)
        title = t.group(1).strip() if t else ""
        d2 = re.search(r"(OIML\s+(?:R|D|B|G|E)\s*[\d/-]+[^\s<]*)", title)
        ident = d2.group(1).strip() if d2 else title or ""
    slug = re.sub(r"[^a-z0-9]+", "-", ident.lower()).strip("-")
    return slug, ident


def r2_put(key: str, data: bytes, content_type: str) -> None:
    tmp = Path(f"/tmp/docup-{key.replace('/', '_')}")
    tmp.write_bytes(data)
    try:
        r = subprocess.run(
            ["npx", "wrangler", "r2", "object", "put", f"{BUCKET}/{key}", "--file", str(tmp),
             "--remote", "--content-type", content_type],
            cwd=WORKER_DIR, capture_output=True, text=True,
            env={**os.environ, "CLOUDFLARE_ACCOUNT_ID": ACCOUNT_ID}, timeout=300,
        )
        if r.returncode != 0:
            sys.exit(f"r2 put {key} failed: {r.stderr[-200:]}")
    finally:
        tmp.unlink(missing_ok=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="upload to R2 (default: report only)")
    args = ap.parse_args()

    total = uploaded = 0
    for html_path in sorted(CLEAN_SOURCES.rglob("document.html")):
        rel = html_path.relative_to(CLEAN_SOURCES)
        if rel.parts[0] in SKIP_DIRS:
            continue
        total += 1
        html = html_path.read_text(encoding="utf-8", errors="replace")
        slug, ident = doc_slug(html)
        if not slug:
            print(f"  SKIP {rel}: no docidentifier")
            continue
        hm = HeadingMap()
        hm.feed(html)
        anchors = hm.anchors
        status = "ok" if anchors else "NO-ANCHORS"
        print(f"  {rel.parts[0]}/{rel.parts[1] if len(rel.parts) > 2 else ''}: {ident} → docs/{slug}.html ({len(anchors)} anchors) {status}")
        if not args.apply or not anchors:
            continue
        r2_put(f"docs/{slug}.html", html.encode("utf-8"), "text/html; charset=utf-8")
        r2_put(f"docs/{slug}.anchors.json", json.dumps(anchors).encode("utf-8"), "application/json; charset=utf-8")
        uploaded += 1
    print(f"documents: {total} · uploaded: {uploaded if args.apply else '0 (report only)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
