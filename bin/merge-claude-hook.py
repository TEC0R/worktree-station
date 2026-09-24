#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Terry Cornelusse
"""Merge the Claude Code settings into ~/.claude/settings.json without overwriting anything.

Adds the dbt-conventions hook and the DEFAULTS below, each only when missing.

The file is merged, not replaced: a broken settings.json silently disables
ALL Claude Code settings.
"""
import json
import shutil
import sys
from pathlib import Path

MATCHER = "Write|Edit|MultiEdit"
# Written only when the key is absent: a value chosen through /config wins.
DEFAULTS = {
    "outputStyle": "Concise",  # terse answers, results first
}


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

    changed = []
    for key, value in DEFAULTS.items():
        if key in data:
            print(f"\033[32m✓\033[0m {key} already set ({data[key]})")
        else:
            data[key] = value
            changed.append(f"{key}={value}")

    hooks = data.setdefault("hooks", {})
    post = hooks.setdefault("PostToolUse", [])
    if any(h.get("command") == command for g in post for h in g.get("hooks", [])):
        print("\033[32m✓\033[0m dbt-conventions hook already present")
    else:
        add_hook(post, command)
        changed.append("dbt-conventions hook")

    if not changed:
        return 0
    shutil.copy2(settings, settings.with_suffix(f".json.backup-{stamp}"))
    settings.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    print(f"\033[32m✓\033[0m added: {', '.join(changed)} "
          f"(backup: settings.json.backup-{stamp})")
    return 0


def add_hook(post: list, command: str) -> None:
    """Append the dbt-conventions hook to the PostToolUse groups.

    Args:
        post: the PostToolUse list of settings.json, modified in place.
        command: absolute path of the hook script.
    """
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


if __name__ == "__main__":
    sys.exit(main())
