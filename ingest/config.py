import os
from pathlib import Path

CLEAN_DIR = Path(os.environ.get("OIML_CLEAN_DIR", str(Path.home() / "src/mn/mn-samples-oiml/sources")))
DIRTY_DIR = Path(os.environ.get("OIML_DIRTY_DIR", str(Path.home() / "src/oimlsmart/publications-private/sources")))
ARTIFACTS = Path(os.environ.get("RAG_ARTIFACTS", "artifacts"))

ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")
INDEX_NAME = os.environ.get("VECTORIZE_INDEX", "idx_oiml_public")

EMBED_MODEL = "@cf/qwen/qwen3-embedding-0.6b"

MAX_CHUNK_CHARS = 2800
SHELL_WORD_THRESHOLD = 100
