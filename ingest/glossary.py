"""Glossary lane (the L2 nomenclature bridge): vocab concepts → vectors.

Everyday words ("my output keeps drifting") don't match defined terms
("durability") — the measured universal gap across all comparison lanes.
This lane embeds the Glossarist concept entries (term designation +
definition, per language, with the defining publication) into
idx_glossary; the serving pipeline links queries to candidate terms
(dense top-k + cross-encoder rerank + answer-model adjudication) and
injects them as a vocabulary note.

Source: ~/src/oimlsmart/vocab/datasets/oiml-complete/concepts/*.yaml
(read-only upstream — never written).

Usage:
  .venv/bin/python -m ingest.cli glossary          # build + embed + upsert
  .venv/bin/python -m ingest.cli glossary --dry    # specs only
"""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

import httpx
import yaml

from .config import ARTIFACTS

VOCAB = Path(os.environ.get("VOCAB_REPO", Path.home() / "src/oimlsmart/vocab"))
CONCEPTS = VOCAB / "datasets/oiml-complete/concepts"
OUT = ARTIFACTS / "glossary_chunks.jsonl"
LANGS = {"eng": "en", "fra": "fr", "deu": "de", "spa": "es", "zho": "zh", "ara": "ar", "rus": "ru", "jpn": "ja"}
BASE = os.environ.get("RAG_BASE", "https://ai.oimlsmart.org").rstrip("/")

# docidentifier "OIML R 60-1:2017 (E)" → doc_number "R 60-1", edition 2017
_REF = re.compile(r"OIML\s+([RDBGE])\s*0*(\d{1,3}(?:-\d+)?)\s*(?::(\d{4}))?")


def _doc_number(ref: str) -> str:
    m = _REF.search(ref or "")
    return f"{m.group(1)} {m.group(2)}" if m else ""


def build_specs() -> list[dict]:
    specs = []
    for f in sorted(CONCEPTS.glob("*.yaml")):
        try:
            docs = list(yaml.safe_load_all(f.read_text(encoding="utf-8")))
        except Exception:
            continue
        if not docs:
            continue
        meta = next((d for d in docs if isinstance(d, dict) and d.get("schema_version")), None)
        if not meta:
            continue
        data = meta.get("data", {})
        ident = str(data.get("identifier", f.stem))
        refs = [s.get("origin", {}).get("ref", {}).get("source", "") for s in data.get("sources", [])]
        refs += [d.get("source", "") for d in data.get("domains", [])]
        pub = next((r for r in refs if r), "")
        for loc in docs:
            if not isinstance(loc, dict) or loc is meta:
                continue
            ld = loc.get("data") or {}
            lang_raw = str(ld.get("language_code", "") or "")
            lang = LANGS.get(lang_raw)
            if not lang:
                continue
            terms = [t.get("designation", "") for t in ld.get("terms", []) if t.get("designation")]
            defs = [d.get("content", "") for d in ld.get("definition", []) if d.get("content")]
            if not terms or not defs:
                continue
            designation = terms[0]
            definition = defs[0]
            alt = "; ".join(t for t in terms[1:] if t)
            text = f"{designation}{' (' + alt + ')' if alt else ''} — {definition}"
            specs.append(
                {
                    "id": f"gl-{ident}-{lang}",
                    "text": text[:2800],
                    "metadata": {
                        "doc_id": ident,
                        "docidentifier": pub or f"OIML vocab {ident}",
                        "doctype": "vocab",
                        "doc_number": _doc_number(pub),
                        "edition": "",
                        "language": lang,
                        "clause_anchor": "",
                        "clause_title": designation,
                        "tier": "curated",
                        "corpus": "glossary",
                        "text_ref": f"vocab/oiml-complete#{ident}",
                        "unit_id": "",
                        "block": "term",
                    },
                }
            )
    return specs


def _dotenv() -> dict[str, str]:
    out: dict[str, str] = {}
    env = ARTIFACTS.parent / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, _, v = line.partition("=")
                out[k.strip()] = v.strip()
    return out


def run(dry: bool = False) -> int:
    specs = build_specs()
    with OUT.open("w", encoding="utf-8") as fh:
        for s in specs:
            fh.write(json.dumps(s, ensure_ascii=False) + "\n")
    langs: dict[str, int] = {}
    for s in specs:
        langs[s["metadata"]["language"]] = langs.get(s["metadata"]["language"], 0) + 1
    print(f"glossary: {len(specs)} entries → {OUT} ({langs})")
    if dry:
        return 0
    env = {**os.environ, **_dotenv()}
    token = env.get("ADMIN_TOKEN")
    api_token = env.get("CLOUDFLARE_API_TOKEN") or env.get("API_TOKEN")
    if not api_token:
        creds = Path.home() / ".cloudflare-credentials-oimlsmart"
        if creds.exists():
            for line in creds.read_text().splitlines():
                if line.startswith("export API_TOKEN="):
                    api_token = line.split("=", 1)[1].strip()
                    break
    account = env.get("CLOUDFLARE_ACCOUNT_ID", "06cad8ae9a017c856ab496c6bca9a9d8")
    h = {"authorization": f"Bearer {token}", "user-agent": "oiml-glossary/1.0"}
    upserted = 0
    with httpx.Client(timeout=300) as c:
        for i in range(0, len(specs), 16):
            b = specs[i : i + 16]
            try:
                r = c.post(f"{BASE}/admin/vectors", headers=h, json={"mode": "embed", "texts": [s["text"] for s in b]})
                vecs = r.json()["vectors"]
                payload = [{"id": s["id"], "values": v, "metadata": {**s["metadata"], "chunk_text": s["text"]}} for s, v in zip(b, vecs)]
                res = c.post(
                    f"https://api.cloudflare.com/client/v4/accounts/{account}/vectorize/v2/indexes/idx_glossary/upsert",
                    headers={"authorization": f"Bearer {api_token}", "content-type": "application/json", "user-agent": "oiml-glossary/1.0"},
                    json={"vectors": payload},
                )
                if res.status_code == 200:
                    upserted += len(b)
                else:
                    print(f"  upsert FAIL {i}: {res.text[:100]}")
            except Exception as e:  # noqa: BLE001
                print(f"  batch FAIL {i}: {str(e)[:100]}")
            if (i // 16) % 20 == 0:
                print(f"  {min(i + 16, len(specs))}/{len(specs)} (done={upserted})", flush=True)
            time.sleep(0.5)
    print(f"[glossary] DONE: {upserted}/{len(specs)} upserted to idx_glossary")
    return 0 if upserted == len(specs) else 1
