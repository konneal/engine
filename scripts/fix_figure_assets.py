#!/usr/bin/env python3
"""Unit-asset readability repair: every image served under /assets/u:* and
attached to multimodal generation must be readable by a vision model.
Vector-sourced figures were rasterized as black strokes on a TRANSPARENT
background; vision endpoints flatten RGBA onto black, so the model receives
a solid black rectangle (the browser never showed the problem — it composites
on white). This script scans unit_payloads for /assets/ URIs, fetches each
R2 object, detects the defect (any ink at all + max RGB == 0), flattens onto
white, and re-uploads in place. Idempotent: healthy assets are skipped.

Usage:
    .venv/bin/python scripts/fix_figure_assets.py [--apply]

R2 access via wrangler OAuth (same as reconcile_index.py). Originals are
backed up to artifacts/asset-backups/ before any overwrite.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ingest.config import ACCOUNT_ID  # noqa: E402

WORKER_DIR = Path(__file__).resolve().parents[1] / "workers" / "worker_public"
BACKUPS = Path(__file__).resolve().parents[1] / "artifacts" / "asset-backups"
BUCKET = "rag-public-assets"


def wrangler_json(*args: str) -> dict:
    r = subprocess.run(
        ["npx", "wrangler", *args], cwd=WORKER_DIR, capture_output=True,
        text=True, env={**os.environ, "CLOUDFLARE_ACCOUNT_ID": ACCOUNT_ID}, timeout=300,
    )
    if r.returncode != 0:
        sys.exit(f"wrangler {' '.join(args[:2])} failed: {r.stderr[-300:]}")
    return json.loads(r.stdout)


def d1_units() -> list[dict]:
    out = wrangler_json(
        "d1", "execute", "rag-public", "--remote", "--json",
        "--command",
        "SELECT unit_id, json_extract(payload,'$.uri') AS uri FROM unit_payloads "
        "WHERE json_extract(payload,'$.uri') LIKE '/assets/%'",
    )
    return out[0]["results"]


def r2_get(key: str) -> bytes | None:
    tmp = Path(f"/tmp/r2fix-{key.replace('/', '_')}")
    r = subprocess.run(
        ["npx", "wrangler", "r2", "object", "get", f"{BUCKET}/{key}",
         "--file", str(tmp), "--remote"],
        cwd=WORKER_DIR, capture_output=True, text=True,
        env={**os.environ, "CLOUDFLARE_ACCOUNT_ID": ACCOUNT_ID}, timeout=300,
    )
    if r.returncode != 0 or not tmp.is_file():
        return None
    data = tmp.read_bytes()
    tmp.unlink(missing_ok=True)
    return data


def r2_put(key: str, data: bytes) -> None:
    tmp = Path(f"/tmp/r2fix-put-{key.replace('/', '_')}")
    tmp.write_bytes(data)
    try:
        r = subprocess.run(
            ["npx", "wrangler", "r2", "object", "put", f"{BUCKET}/{key}",
             "--file", str(tmp), "--remote", "--content-type", "image/png"],
            cwd=WORKER_DIR, capture_output=True, text=True,
            env={**os.environ, "CLOUDFLARE_ACCOUNT_ID": ACCOUNT_ID}, timeout=300,
        )
        if r.returncode != 0:
            sys.exit(f"r2 put {key} failed: {r.stderr[-300:]}")
    finally:
        tmp.unlink(missing_ok=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="repair + re-upload (default: report only)")
    args = ap.parse_args()

    from PIL import Image  # noqa: PLC0415 — optional dep, only needed when repairing

    units = d1_units()
    print(f"unit assets: {len(units)}")
    defective = 0
    for row in units:
        key = row["uri"].removeprefix("/assets/")
        if not key.lower().endswith((".png", ".jpg", ".jpeg")):
            print(f"  {key}: not a raster (svg?) — skipped, vision models cannot consume it directly")
            continue
        data = r2_get(key)
        if data is None:
            print(f"  {key}: MISSING from R2")
            continue
        im = Image.open(io.BytesIO(data))
        if im.mode != "RGBA":
            print(f"  {key}: {im.mode} {im.size} — healthy")
            continue
        r, g, b, a = im.split()
        ink = sum(a.histogram()[1:])
        if ink == 0 or (r.getextrema()[1], g.getextrema()[1], b.getextrema()[1]) != (0, 0, 0):
            print(f"  {key}: RGBA {im.size} but carries color — healthy")
            continue
        defective += 1
        flat = Image.new("RGB", im.size, (255, 255, 255))
        flat.paste(im, mask=a)
        buf = io.BytesIO()
        flat.save(buf, format="PNG", optimize=True)
        print(f"  {key}: RGBA {im.size}, {ink} ink px, RGB all-black — DEFECT; "
              f"flattened onto white ({len(buf.getvalue())} bytes)")
        if not args.apply:
            continue
        BACKUPS.mkdir(parents=True, exist_ok=True)
        (BACKUPS / key.replace("/", "_")).write_bytes(data)
        r2_put(key, buf.getvalue())
        print(f"    repaired (original backed up to {BACKUPS / key.replace('/', '_')})")
        time.sleep(1)
    if defective and not args.apply:
        print("report-only; rerun with --apply to repair")
        return 1
    print(f"defective: {defective}" + (" — repaired" if args.apply and defective else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
