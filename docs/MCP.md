# OIML SMART AI — MCP Server

*Agent-native access to the OIML publications corpus via the Model
Context Protocol. For chat/API usage see [API.md](API.md); MCP is the
machine contract — including the publication registry, which is
deliberately NOT part of the chatbot API.*

---

## 1. Connecting

**Endpoint:** `https://rag-mcp.oimlsmart-06c.workers.dev/mcp`
**Transport:** Streamable HTTP (MCP `2025-06-18`) — JSON-RPC 2.0 over
`POST /mcp`, stateless. `GET /` returns a service descriptor.

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "oiml": {
      "type": "http",
      "url": "https://rag-mcp.oimlsmart-06c.workers.dev/mcp"
    }
  }
}
```
**Any MCP client:** point it at the URL above; no session handshake
state is required beyond the standard `initialize` call.

**Authorization:** the server is public-tier by default. Setting the
`RAG_API_KEY` secret (operator) raises its quota class; per-caller auth
is passed through the underlying API key if configured.

## 2. Tools

### `oiml_search` — ranked passage retrieval
```jsonc
// input
{ "query": "maximum permissible error load cell", "top_k": 3 }  // top_k 1–10
```
Returns passages as text blocks:
```
OIML R 76-1:2006 §2.5.4 — 2.5.4 Maximum permissible error, mpe (T.5.4.4)
<snippet>
```
Use for: scanning the corpus, gathering context, cheap lookups (no
generation cost).

### `oiml_ask` — grounded, citation-linked answers
```jsonc
{ "query": "What does OIML R 60-1 require for verification intervals?" }
```
Returns the full answer plus a `Sources:` line of cited passages. Every
claim cites the exact publication and clause; normative values carry
verbatim quote anchors. Off-corpus questions return the canonical
refusal sentence.

### `oiml_documents` — publication registry (editions & status)
```jsonc
{ "family": "R-60" }   // series letter + number, e.g. "R-60", "B-18", "D-11"
```
Returns every edition of the family with derived status:
```
OIML R 60:1991 — superseded → superseded by OIML R 60:2000
OIML R 60:2021 — in-force [ACTIVE]
OIML R 60-1:2017 — superseded → superseded by OIML R 60-1:2021
OIML R 60-1:2021 — in-force [ACTIVE]
…
```
`[ACTIVE]` is DERIVED from successor edges (terminal node of the
supersession chain), not from a status field — relaton's status field
contradicts its own edges in ~9% of records. Use for: "current/latest
edition", edition history, supersession questions. A family with no
`[ACTIVE]` line means the bibliographic data has a gap (missing
successor edge) — the registry surfaces it rather than guessing.

## 3. Protocol notes

- Notifications (no `id`) → `202`, no body
- Unknown method → `-32601`
- Tool failures → result with `isError: true` and the message (never a
  dropped call)
- `initialize` responds with capabilities `{tools:{}}`; `tools/list`
  returns the three tool definitions with JSON schemas

## 4. Implementation & isolation

The server (`workers/worker_mcp`, `rag-mcp`) holds **no corpus access
of its own**: `oiml_search`/`oiml_ask` proxy the rag-public API (so
audience isolation stays enforced in exactly one place), and
`oiml_documents` reads the derived D1 registry via a read-only binding
(public OIML metadata only — no ISO/IEC content).
