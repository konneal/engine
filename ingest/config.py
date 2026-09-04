import os
from pathlib import Path

CLEAN_DIR = Path(os.environ.get("OIML_CLEAN_DIR", str(Path.home() / "src/mn/mn-samples-oiml/sources")))
DIRTY_DIR = Path(os.environ.get("OIML_DIRTY_DIR", str(Path.home() / "src/oimlsmart/publications-private/sources")))
ARTIFACTS = Path(os.environ.get("RAG_ARTIFACTS", "artifacts"))

def _load_dotenv() -> None:
    env_file = Path(".env")
    if not env_file.is_file():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


_load_dotenv()

ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")
INDEX_NAME = os.environ.get("VECTORIZE_INDEX", "idx_oiml_public")


def _wrangler_oauth_token() -> str:
    """Reuse the token stored by `wrangler login` when no API token is set."""
    import re
    from pathlib import Path

    candidates = [
        Path.home() / "Library/Preferences/.wrangler/config/default.toml",
        Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / ".wrangler/config/default.toml",
        Path.home() / ".wrangler/config/default.toml",
    ]
    token_re = re.compile(r'^(oauth_token|api_token)\s*=\s*"?([^"\n]+)"?', re.M)
    for p in candidates:
        if p.is_file():
            m = token_re.search(p.read_text())
            if m:
                return m.group(2).strip()
    return ""


if not API_TOKEN:
    API_TOKEN = _wrangler_oauth_token()

EMBED_MODEL = "@cf/qwen/qwen3-embedding-0.6b"

MAX_CHUNK_CHARS = 2800
SHELL_WORD_THRESHOLD = 100
# English-only index (2026-08-24 user directive): multilingual chunks made
# follow-up questions retrieve unrelated content; non-English documents
# are excluded at ingest. Output language stays a serving-time concern.
# The declared language is verified against the content (ingest/langid.py,
# issue #72); whole-edition exclusions are recorded with evidence in
# ingest/corpus-exclusions.yaml.
INGEST_LANGUAGES = {"en"}
