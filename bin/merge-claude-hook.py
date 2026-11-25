#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Terry Cornelusse
"""Merge the Claude Code settings into ~/.claude/settings.json without overwriting anything.

Adds the HOOKS and the DEFAULTS below, each only when missing.

The file is merged, not replaced: a broken settings.json silently disables
ALL Claude Code settings.
"""
import json
import shutil
import sys
from pathlib import Path
from typing import Optional

# (event, matcher, script under claude/hooks/, timeout, status message).
# A None matcher means every event of that kind.
HOOKS = [
    ("PostToolUse", "Write|Edit|MultiEdit", "dbt-conventions.py", 15, "Checking dbt conventions…"),
    # Writes to the wts inbox when a session waits on a human (permission, idle).
    ("Notification", None, "notify-inbox.py", 5, None),
]
# Written only when the key is absent: a value chosen through /config wins.
DEFAULTS = {
    "outputStyle": "Concise",  # terse answers, results first
}


def main() -> int:
    settings = Path(sys.argv[1])
    dotfiles = Path(sys.argv[2])
    stamp = sys.argv[3] if len(sys.argv) > 3 else "backup"

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
    for event, matcher, script, timeout, status in HOOKS:
        command = f"{dotfiles}/claude/hooks/{script}"
        groups = hooks.setdefault(event, [])
        if any(h.get("command") == command for g in groups for h in g.get("hooks", [])):
            print(f"\033[32m✓\033[0m {script} hook already present")
        else:
            add_hook(groups, matcher, command, timeout, status)
            changed.append(f"{script} hook")

    if not changed:
        return 0
    shutil.copy2(settings, settings.with_suffix(f".json.backup-{stamp}"))
    settings.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    print(f"\033[32m✓\033[0m added: {', '.join(changed)} "
          f"(backup: settings.json.backup-{stamp})")
    return 0


def add_hook(groups: list, matcher: Optional[str], command: str, timeout: int, status: Optional[str]) -> None:
    """Append a hook to the groups of one event.

    Args:
        groups: the list of that event in settings.json, modified in place.
        matcher: the group's matcher, or None for a group without matcher.
        command: absolute path of the hook script.
        timeout: seconds before Claude Code gives up on the hook.
        status: message shown while the hook runs, if any.
    """
    entry = {"type": "command", "command": command, "timeout": timeout}
    if status:
        entry["statusMessage"] = status

    for group in groups:
        if group.get("matcher") == matcher:
            group.setdefault("hooks", []).append(entry)
            break
    else:
        groups.append({"hooks": [entry]} if matcher is None else {"matcher": matcher, "hooks": [entry]})


if __name__ == "__main__":
    sys.exit(main())
