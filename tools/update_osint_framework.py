#!/usr/bin/env python3
"""Refresh web/data/osint-framework.json from the OSINT Framework project.

    python3 tools/update_osint_framework.py              # download latest arf.json
    python3 tools/update_osint_framework.py path/arf.json

OSINT Framework (https://osintframework.com) is MIT-licensed by Justin Nordine;
see web/data/OSINT-FRAMEWORK-LICENSE. The upstream tree is converted into a flat,
compact list so the browser can filter all ~1,200 tools instantly.
"""

import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SOURCE = "https://raw.githubusercontent.com/lockfale/OSINT-Framework/master/public/arf.json"
OUT = Path(__file__).resolve().parent.parent / "web" / "data" / "osint-framework.json"

# Upstream name suffixes: (T) local tool, (D) Google dork, (R) registration, (M) edit URL manually.
SUFFIX = re.compile(r"\s*\((?:T|D|R|M)\)\s*")

FLAGS = {  # upstream boolean field -> one-letter flag
    "localInstall": "T", "googleDork": "D", "registration": "R", "editUrl": "M",
    "api": "A", "invitationOnly": "I", "deprecated": "X",
}


def norm(value):
    return value.strip().lower() if isinstance(value, str) else None


def flatten(node, path, out, seen):
    if node.get("url") and not node.get("children"):
        name = node["name"]
        flags = {f for k, f in FLAGS.items() if node.get(k)}
        for tag in re.findall(r"\((T|D|R|M)\)", name):
            flags.add(tag)
        tool = {
            "n": SUFFIX.sub(" ", name).strip(),
            "u": node["url"],
            "c": path,
            "d": node.get("description"),
            "b": node.get("bestFor"),
            "i": node.get("input"),
            "o": node.get("output"),
            "s": norm(node.get("status")),
            "p": norm(node.get("pricing")),
            "op": norm(node.get("opsec")),
            "on": node.get("opsecNote"),
            "f": "".join(sorted(flags)),
        }
        key = (tool["n"], tool["u"], tuple(path))
        # Skip duplicates within a folder, and anything that isn't a plain web link
        # (upstream has a javascript: bookmarklet).
        if key not in seen and tool["u"].startswith(("http://", "https://")):
            seen.add(key)
            out.append({k: v for k, v in tool.items() if v not in (None, "", [])})
    for child in node.get("children") or []:
        flatten(child, path + [child["name"]] if child.get("children") else path, out, seen)


def main():
    if len(sys.argv) > 1:
        raw = json.loads(Path(sys.argv[1]).read_text())
    else:
        with urllib.request.urlopen(SOURCE, timeout=60) as resp:
            raw = json.load(resp)
    tools, seen = [], set()
    for top in raw.get("children", []):
        flatten(top, [top["name"]], tools, seen)
    categories = [c["name"] for c in raw.get("children", [])]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "source": "https://osintframework.com",
        "license": "MIT (c) Justin Nordine, see OSINT-FRAMEWORK-LICENSE",
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "categories": categories,
        "tools": tools,
    }, separators=(",", ":"), ensure_ascii=False))
    print(f"{len(tools)} tools in {len(categories)} categories → {OUT}")


if __name__ == "__main__":
    main()
