#!/usr/bin/env python3
"""Bulk figure-asset import (#172's unlock): the typed figure units carry
producer anchors (fig-c-1, fig-2a…) and the CLEAN corpus sources embed
each figure's image (data URI inside document.xml, or images/ files).
This script maps unit → source image, white-flattens (the vision
readability contract — see fix_figure_assets.py), uploads to R2 as
u:<id>.png, and sets payload.uri in unit_payloads.

Dirty-corpus OCR images (bbox refs, ccitt encodings) are out of scope
for this pass — noted for a follow-up.

Usage:
    .venv/bin/python scripts/import_figure_assets.py [--apply]
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ingest.config import ACCOUNT_ID  # noqa: E402

CLEAN_SOURCES = Path.home() / "src/mn/mn-samples-oiml/sources"
WORKER_DIR = Path(__file__).resolve().parents[1] / "workers" / "worker_public"
BUCKET = "rag-public-assets"

FIG_RE = re.compile(r'<figure[^>]*anchor="([^"]+)"[^>]*>(.*?)</figure>', re.S)
IMG_RE = re.compile(r'src="([^"]+)"')
DATA_URI_RE = re.compile(r"^data:image/(png|jpe?g);base64,(.+)$", re.S)


def wrangler_json(*args: str) -> dict:
    r = subprocess.run(["npx", "wrangler", *args], cwd=WORKER_DIR, capture_output=True,
                       text=True, env={**os.environ, "CLOUDFLARE_ACCOUNT_ID": ACCOUNT_ID}, timeout=300)
    if r.returncode != 0:
        sys.exit(f"wrangler {' '.join(args[:2])} failed: {r.stderr[-300:]}")
    return json.loads(r.stdout)


def r2_put(key: str, data: bytes) -> None:
    tmp = Path(f"/tmp/figimp-{key.replace('/', '_')}")
    tmp.write_bytes(data)
    try:
        r = subprocess.run(["npx", "wrangler", "r2", "object", "put", f"{BUCKET}/{key}",
                            "--file", str(tmp), "--remote", "--content-type", "image/png"],
                           cwd=WORKER_DIR, capture_output=True, text=True,
                           env={**os.environ, "CLOUDFLARE_ACCOUNT_ID": ACCOUNT_ID}, timeout=300)
        if r.returncode != 0:
            sys.exit(f"r2 put {key} failed: {r.stderr[-200:]}")
    finally:
        tmp.unlink(missing_ok=True)


def clean_corpus_figures() -> dict[tuple[str, str], bytes]:
    """(docidentifier, figure-anchor) → image bytes, from the clean
    corpus's document.xml files (embedded data URIs preferred; images/
    files by name as fallback)."""
    out: dict[tuple[str, str], bytes] = {}
    for src in sorted(CLEAN_SOURCES.iterdir()):
        xml_path = src / "document.xml"
        if not xml_path.is_file():
            continue
        xml = xml_path.read_text(encoding="utf-8", errors="replace")
        bib = re.search(r"<docidentifier[^>]*>([^<]+)</docidentifier>", xml)
        if not bib:
            continue
        docid = re.sub(r"\s*\([A-Z]\)\s*$", "", bib.group(1).strip())
        for anchor, body in FIG_RE.findall(xml):
            if (docid, anchor) in out:
                continue
            m = IMG_RE.search(body)
            if not m:
                continue
            src_ref = m.group(1)
            data = None
            dm = DATA_URI_RE.match(src_ref)
            if dm:
                try:
                    data = base64.b64decode(dm.group(2))
                except Exception:
                    data = None
            else:
                f = src / src_ref if not src_ref.startswith("/") else None
                if f and f.is_file():
                    data = f.read_bytes()
            if data:
                out[(docid, anchor)] = data
    return out


def vision_safe_png(data: bytes) -> bytes | None:
    """Decode → white-flatten onto opaque RGB → re-encode PNG. Returns
    None when the bytes are not a decodable raster (the SVG case is
    rasterized by the caller)."""
    from PIL import Image

    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except Exception:
        return None
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        r, g, b, a = im.split()
        ink = sum(a.histogram()[1:])
        rgb_all_black = (r.getextrema()[1], g.getextrema()[1], b.getextrema()[1]) == (0, 0, 0)
        if ink and rgb_all_black:
            flat = Image.new("RGB", im.size, (255, 255, 255))
            flat.paste(im, mask=a)
            im = flat
        else:
            im = im.convert("RGB")
    elif im.mode != "RGB":
        im = im.convert("RGB")
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def rasterize_svg(data: bytes) -> bytes | None:
    r = subprocess.run(["rsvg-convert", "--background-color=white", "--width", "1200"],
                       input=data, capture_output=True, timeout=60)
    return r.stdout if r.returncode == 0 and r.stdout[:4] == b"\x89PNG" else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    units = wrangler_json("d1", "execute", "rag-public", "--remote", "--json", "--command",
                          "SELECT unit_id, docidentifier, json_extract(payload,'$.uri') AS uri "
                          "FROM unit_payloads WHERE type='figure'")[0]["results"]
    todo = [u for u in units if not u["uri"]]
    print(f"figure units: {len(units)}, without asset uri: {len(todo)}")

    corpus = clean_corpus_figures()
    print(f"clean-corpus figure images indexed: {len(corpus)} "
          f"({len({d for d, _ in corpus})} documents)")

    imported = unmatched = 0
    for u in todo:
        anchor = u["unit_id"].removeprefix("u:")
        key = (u["docidentifier"], anchor)
        data = corpus.get(key)
        if data is None:
            # anchor-name drift: fig-X ↔ figure-X file names
            alt = (u["docidentifier"], anchor.replace("fig-", "figure-", 1))
            data = corpus.get(alt)
        if data is None:
            print(f"  {u['unit_id']} ({u['docidentifier']}): no source image found")
            unmatched += 1
            continue
        png = vision_safe_png(data) or rasterize_svg(data)
        if not png:
            print(f"  {u['unit_id']}: undecodable image ({len(data)}b) — skipped")
            unmatched += 1
            continue
        print(f"  {u['unit_id']} ({u['docidentifier']}): {len(data)}b → {len(png)}b png")
        imported += 1
        if not args.apply:
            continue
        r2_put(f"{u['unit_id']}.png", png)
        wrangler_json("d1", "execute", "rag-public", "--remote", "--json", "--command",
                      f"UPDATE unit_payloads SET payload = json_set(payload, '$.uri', '/assets/{u['unit_id']}.png') "
                      f"WHERE unit_id = '{u['unit_id']}'")
        time.sleep(0.5)

    print(f"imported: {imported}, unmatched: {unmatched}")
    if not args.apply:
        print("report-only; rerun with --apply to upload + set uris")
    return 0


if __name__ == "__main__":
    sys.exit(main())
