from __future__ import annotations

import time
from typing import Any

import httpx

from .config import ACCOUNT_ID, API_TOKEN, EMBED_MODEL, INDEX_NAME

BASE = "https://api.cloudflare.com/client/v4"


def _require_auth() -> None:
    if not ACCOUNT_ID or not API_TOKEN:
        raise SystemExit("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (wrangler login token works).")


class CF:
    def __init__(self) -> None:
        _require_auth()
        self.client = httpx.Client(
            headers={"Authorization": f"Bearer {API_TOKEN}"},
            timeout=httpx.Timeout(120.0),
        )

    def _post(self, url: str, json: dict) -> dict:
        delay = 2.0
        for attempt in range(6):
            r = self.client.post(url, json=json)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(delay)
                delay = min(delay * 2, 60)
                continue
            r.raise_for_status()
            return r.json()
        raise RuntimeError(f"persistent failure POST {url}")

    def embed(self, texts: list[str]) -> list[list[float]]:
        url = f"{BASE}/accounts/{ACCOUNT_ID}/ai/run/{EMBED_MODEL}"
        shapes: list[dict] = [
            {"input": {"input": texts}},
            {"input": texts},
            {"text": texts},
        ]
        last_err: Exception | None = None
        for body in shapes:
            try:
                data = self._post(url, body)
                vecs = self._extract_vecs(data)
                if vecs and len(vecs) == len(texts):
                    return vecs
            except Exception as e:  # noqa: BLE001 — try next shape
                last_err = e
        raise RuntimeError(f"embedding failed for all shapes: {last_err}")

    @staticmethod
    def _extract_vecs(data: dict) -> list[list[float]] | None:
        res = data.get("result", data)
        d = res.get("data", res) if isinstance(res, dict) else res
        if isinstance(d, dict):
            d = d.get("data", d.get("embeddings"))
        if not isinstance(d, list) or not d:
            return None
        first = d[0]
        if isinstance(first, list):
            return [v for v in d]
        if isinstance(first, dict) and isinstance(first.get("embedding"), list):
            return [v["embedding"] for v in d]
        return None

    def vectorize_info(self) -> dict:
        r = self.client.get(f"{BASE}/accounts/{ACCOUNT_ID}/vectorize/v2/indexes/{INDEX_NAME}")
        r.raise_for_status()
        return r.json()["result"]

    def vectorize_upsert(self, vectors: list[dict]) -> None:
        for i in range(0, len(vectors), 100):
            batch = vectors[i : i + 100]
            self._post(
                f"{BASE}/accounts/{ACCOUNT_ID}/vectorize/v2/indexes/{INDEX_NAME}/upsert",
                {"vectors": batch},
            )
            print(f"  upserted {min(i + 100, len(vectors))}/{len(vectors)}")

    def vectorize_query(self, vec: list[float], top_k: int = 5) -> list[dict[str, Any]]:
        data = self._post(
            f"{BASE}/accounts/{ACCOUNT_ID}/vectorize/v2/indexes/{INDEX_NAME}/query",
            {"vector": vec, "topK": top_k, "returnMetadata": "all"},
        )
        return data.get("result", {}).get("matches", [])
