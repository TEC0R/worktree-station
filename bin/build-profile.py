#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Terry Cornelusse
"""Bundle the dotfiles into a .code-profile that VS Code can import.

Used as a backup and as a sharing format (new machine, team onboarding).
Day to day, the symlinks installed by install.sh are the source of truth.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

PLATFORM_MAC = 1  # vs/base/common/platform : Web=0, Mac=1, Linux=2, Windows=3


def strip_jsonc(text: str) -> str:
    """Strip // comments and trailing commas (VS Code tolerates them, json does not)."""
    text = re.sub(r'^\s*//.*$', '', text, flags=re.M)
    text = re.sub(r',(\s*[}\]])', r'\1', text)
    return text


def load(path: Path):
    return json.loads(strip_jsonc(path.read_text()))


def installed_extensions() -> list:
    try:
        out = subprocess.run(["code", "--list-extensions"], capture_output=True,
                             text=True, timeout=60, check=True).stdout
    except Exception as exc:                      # code CLI missing or slow
        print(f"~ extensions not listed ({exc})", file=sys.stderr)
        return []
    return [{"identifier": {"id": e.strip()}} for e in out.splitlines() if e.strip()]


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else Path.home() / ".dotfiles")
    vs = root / "vscode"
    name = "worktree-station"

    snippets = {
        p.name: p.read_text()
        for p in sorted((vs / "snippets").glob("*.code-snippets"))
    }

    profile = {
        "name": name,
        "icon": "database",
        "settings": json.dumps({"settings": json.dumps(load(vs / "settings.json"), indent=2)}),
        "keybindings": json.dumps({
            "keybindings": json.dumps(load(vs / "keybindings.json"), indent=2),
            "platform": PLATFORM_MAC,
        }),
        "tasks": json.dumps({"tasks": json.dumps(load(vs / "tasks.json"), indent=2)}),
        "snippets": json.dumps({"snippets": snippets}),
        "extensions": json.dumps(installed_extensions()),
        "globalState": json.dumps({"storage": {}}),
    }

    out = vs / f"{name}.code-profile"
    out.write_text(json.dumps(profile, indent=2, ensure_ascii=False))
    print(f"{out}  ({len(snippets)} snippet files, "
          f"{len(json.loads(profile['extensions']))} extensions)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
