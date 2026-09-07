from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import httpx

from .config import ACCOUNT_ID, API_TOKEN, ARTIFACTS, EMBED_MODEL, INDEX_NAME

BASE = "https://api.cloudflare.com/client/v4"


def _shape_body(name: str, texts: list[str]) -> dict:
    if name == "text":
        return {"text": texts}
    if name == "input.input":
        return {"input": {"input": texts}}
    return {"input": texts}


def _load_shape() -> str | None:
    p = ARTIFACTS / "embed_shape.txt"
    if p.is_file():
        s = p.read_text().strip()
        if s:
            return s
    return None


def _remember_shape(name: str) -> None:
    global _KNOWN_SHAPE
    _KNOWN_SHAPE = name
    ARTIFACTS.mkdir(exist_ok=True)
    (ARTIFACTS / "embed_shape.txt").write_text(name)


_KNOWN_SHAPE = _load_shape()


def _require_auth() -> None:
    if not ACCOUNT_ID or not API_TOKEN:
        raise SystemExit("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (wrangler login token works).")


class CF:
    def __init__(self) -> None:
        _require_auth()
        self.headers = {"Authorization": f"Bearer {API_TOKEN}"}

    def _request(self, method: str, url: str, **kw) -> httpx.Response:
        # A fresh connection per request: pooled keep-alive connections to the
        # AI endpoint were observed wedging under concurrent load.
        kw.setdefault("timeout", httpx.Timeout(300.0))
        return httpx.request(method, url, headers=self.headers, **kw)

    def _post(self, url: str, json: dict) -> dict:
        delay = 2.0
        for attempt in range(6):
            r = self._request("POST", url, json=json)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(delay)
                delay = min(delay * 2, 60)
                continue
            r.raise_for_status()
            return r.json()
        raise RuntimeError(f"persistent failure POST {url}")

    def embed(self, texts: list[str]) -> list[list[float]]:
        url = f"{BASE}/accounts/{ACCOUNT_ID}/ai/run/{EMBED_MODEL}"
        if _KNOWN_SHAPE is None:
            shapes: list[tuple[str, dict]] = [
                ("text", {"text": texts}),
                ("input.input", {"input": {"input": texts}}),
                ("array", {"input": texts}),
            ]
        else:
            shapes = [(_KNOWN_SHAPE, _shape_body(_KNOWN_SHAPE, texts))]
        last_err: Exception | None = None
        for name, body in shapes:
            try:
                data = self._post(url, body)
                vecs = self._extract_vecs(data)
                if vecs and len(vecs) == len(texts):
                    _remember_shape(name)
                    return vecs
            except httpx.HTTPStatusError as e:
                if e.response.status_code in (400, 422):
                    last_err = e
                    continue  # wrong request shape — try the next
                if e.response.status_code == 401:
                    # the REST token's AI-run scope flakes (three waves
                    # running); the deployed worker's binding path is the
                    # reliable equivalent — fall back rather than fail the
                    # wave on recoverable auth
                    return self._embed_via_binding(texts)
                raise  # 429-after-retries / 5xx — not a shape problem
        raise RuntimeError(f"embedding failed for all shapes: {last_err}")

    def _embed_via_binding(self, texts: list[str]) -> list[list[float]]:
        import os as _os

        from pathlib import Path as _Path

        env: dict[str, str] = {}
        env_file = _Path(__file__).resolve().parents[1] / ".env"
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                if "=" in line and not line.lstrip().startswith("#"):
                    k, _, v = line.partition("=")
                    env[k.strip()] = v.strip()
        token = env.get("ADMIN_TOKEN") or _os.environ.get("ADMIN_TOKEN")
        if not token:
            raise RuntimeError("embedding REST 401 and no ADMIN_TOKEN for the binding fallback")
        base = _os.environ.get("RAG_BASE", "https://ai.oimlsmart.org").rstrip("/")
        out: list[list[float]] = []
        with httpx.Client(timeout=300) as c:
            for i in range(0, len(texts), 16):
                r = c.post(
                    f"{base}/admin/vectors",
                    headers={"authorization": f"Bearer {token}", "user-agent": "oiml-ingest-fallback/1.0"},
                    json={"mode": "embed", "texts": texts[i : i + 16]},
                )
                r.raise_for_status()
                out += r.json()["vectors"]
        return out

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
        r = self._request("GET", f"{BASE}/accounts/{ACCOUNT_ID}/vectorize/v2/indexes/{INDEX_NAME}")
        r.raise_for_status()
        return r.json()["result"]

    def vectorize_upsert(self, vectors: list[dict], state_path: Path | None = None) -> None:
        # resumable: record the completed batch cursor so a retry (network
        # drop, expired token) continues instead of restarting from zero
        start = 0
        if state_path and state_path.exists():
            start = int(state_path.read_text().strip() or 0)
        url = f"{BASE}/accounts/{ACCOUNT_ID}/vectorize/v2/indexes/{INDEX_NAME}/upsert"
        for i in range(start, len(vectors), 100):
            batch = vectors[i : i + 100]
            self._post(url, {"vectors": batch})
            if state_path:
                state_path.write_text(str(i + 100))
            print(f"  upserted {min(i + 100, len(vectors))}/{len(vectors)}")
        if state_path and state_path.exists():
            state_path.unlink()

    def vectorize_delete(self, ids: list[str]) -> None:
        url = f"{BASE}/accounts/{ACCOUNT_ID}/vectorize/v2/indexes/{INDEX_NAME}/delete_by_ids"
        for i in range(0, len(ids), 100):
            self._post(url, {"ids": ids[i : i + 100]})
            print(f"  deleted {min(i + 100, len(ids))}/{len(ids)}")

    def kv_get(self, namespace_id: str, key: str) -> str | None:
        r = self._request("GET", f"{BASE}/accounts/{ACCOUNT_ID}/storage/kv/namespaces/{namespace_id}/values/{key}")
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.text

    def kv_put(self, namespace_id: str, key: str, value: str) -> None:
        r = self._request("PUT", f"{BASE}/accounts/{ACCOUNT_ID}/storage/kv/namespaces/{namespace_id}/values/{key}", content=value.encode())
        r.raise_for_status()

    def vectorize_query(self, vec: list[float], top_k: int = 5) -> list[dict[str, Any]]:
        data = self._post(
            f"{BASE}/accounts/{ACCOUNT_ID}/vectorize/v2/indexes/{INDEX_NAME}/query",
            {"vector": vec, "topK": top_k, "returnMetadata": "all"},
        )
        return data.get("result", {}).get("matches", [])
