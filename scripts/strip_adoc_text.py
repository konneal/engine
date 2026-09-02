#!/usr/bin/env python3
"""Lane A builder (TODO.model-rag/04): .adoc → plain prose.

Strips ALL Metanorma/AsciiDoc syntax to linear text — the "legacy format"
representation. Tables collapse to comma-separated values on one line
(geometry deliberately destroyed — that IS the condition of lane A).
Asserts zero surviving markup tokens before writing.

  .venv/bin/python scripts/strip_adoc_text.py <in.adoc> <out.txt>
"""
import re
import sys
from pathlib import Path

MARKUP_PATTERNS = [
    r"^\s*[=.]{4,}\s*$",            # delimiters
    r"\[\[[^\]]+\]\]",              # anchors
    r"<<[^>]+>>",                   # xrefs
    r"\b(stem|unitsml|include|ifdef|ifndef|endif|image|footnote):[^\s]*",  # macros
    r"^\s*//",                      # line comments
]


def strip(adoc: str) -> str:
    out_lines = []
    for line in adoc.splitlines():
        s = line.rstrip()
        if re.match(MARKUP_PATTERNS[0], s) or s.lstrip().startswith("//"):
            continue
        s = re.sub(r"\[\[[^\]]+\]\]", "", s)
        s = re.sub(r"<<[^>]+>>", "", s)
        s = re.sub(r"\b(stem|unitsml|include|ifdef|ifndef|endif|image|footnote):[^\s]+", "", s)
        s = re.sub(r"[.<>#=~^]{3,}", " ", s)          # adoc attrs/rules
        s = re.sub(r"\|", " , ", s)                    # table geometry → list
        s = re.sub(r"\{[a-z_]+\}", " ", s)             # attrs
        s = re.sub(r"[*_`^\[\]]", "", s)               # inline emphasis/markup
        s = re.sub(r"\s{2,}", " ", s).strip()
        if s:
            out_lines.append(s)
    return "\n".join(out_lines)


def main() -> int:
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    text = strip(src.read_text(encoding="utf-8"))
    leftovers = [p for p in MARKUP_PATTERNS[1:] if re.search(p, text)]
    assert not leftovers, f"markup survived: {leftovers[:3]}"
    dst.write_text(text, encoding="utf-8")
    print(f"stripped {src.name}: {len(text.splitlines())} prose lines, zero markup tokens")
    return 0


if __name__ == "__main__":
    sys.exit(main())
