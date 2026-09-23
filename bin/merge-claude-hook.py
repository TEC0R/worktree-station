#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Terry Cornelusse
"""Add the dbt-conventions hook to ~/.claude/settings.json without overwriting anything.

The file is merged, not replaced: a broken settings.json silently disables
ALL Claude Code settings.
"""
import json
import shutil
import sys
from pathlib import Path

MATCHER = "Write|Edit|MultiEdit"


def main() -> int:
    settings = Path(sys.argv[1])
    dotfiles = Path(sys.argv[2])
    stamp = sys.argv[3] if len(sys.argv) > 3 else "backup"
    command = f"{dotfiles}/claude/hooks/dbt-conventions.py"

    try:
        data = json.loads(settings.read_text())
    except json.JSONDecodeError as exc:
        print(f"\033[31m✗\033[0m {settings} is invalid JSON ({exc}) — hook not installed")
        return 1

    hooks = data.setdefault("hooks", {})
    post = hooks.setdefault("PostToolUse", [])

    for group in post:
        for h in group.get("hooks", []):
            if h.get("command") == command:
                print("\033[32m✓\033[0m dbt-conventions hook already present")
                return 0

    entry = {
        "type": "command",
        "command": command,
        "timeout": 15,
        "statusMessage": "Checking dbt conventions…",
    }

    for group in post:
        if group.get("matcher") == MATCHER:
            group.setdefault("hooks", []).append(entry)
            break
    else:
        post.append({"matcher": MATCHER, "hooks": [entry]})

    shutil.copy2(settings, settings.with_suffix(f".json.backup-{stamp}"))
    settings.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    print(f"\033[32m✓\033[0m dbt-conventions hook added "
          f"(backup: settings.json.backup-{stamp})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
