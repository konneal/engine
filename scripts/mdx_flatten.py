#!/usr/bin/env python3
"""Generate the flat .md from the canonical .mdx (TODO.remaining/13).

The paper's single source is the .mdx (frontmatter + Figure JSX); this
flattener emits the submission .md with markdown image syntax so the two
can never drift again. Run after editing the .mdx:
    python3 scripts/mdx_flatten.py docs/paper-oiml-bulletin.mdx docs/paper-oiml-bulletin.md
"""
import re
import sys
from pathlib import Path


def flatten(mdx: str) -> str:
    s = re.sub(r"^---\n.*?\n---\n", "", mdx, count=1, flags=re.DOTALL)  # frontmatter
    s = re.sub(r"^export const Figure[\s\S]*?;\n", "", s, count=1, flags=re.MULTILINE)  # component
    def fig(m):
        attrs = dict(re.findall(r'(\w+)\s*=\s*"([^"]*)"', m.group(1)))
        src, cap = attrs.get("src", ""), attrs.get("caption", "")
        return f"![{cap}]( {src} )\n\n*{cap}*\n".replace("( ", "(").replace(" )", ")")
    s = re.sub(r"<Figure\b([^>]*?)\s*/>", fig, s, flags=re.DOTALL)
    return s.lstrip()


src, dst = Path(sys.argv[1]), Path(sys.argv[2])
dst.write_text(flatten(src.read_text(encoding="utf-8")), encoding="utf-8")
print(f"flattened {src} -> {dst} ({len(dst.read_text())} chars)")
