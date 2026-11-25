#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Terry Cornelusse
"""Claude Code Notification hook: record that a session is waiting on a human.

Claude Code fires Notification when a session needs a permission or has been idle
waiting for input. Each event becomes one JSON line in the wts inbox, so another
process (a supervising agent, `wts inbox`) can see which session waits, without
watching every window.
"""
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("WTS_CONFIG_DIR", Path.home() / ".config" / "wts"))
INBOX_FILE = Path(os.environ.get("WTS_INBOX_FILE", CONFIG_DIR / "inbox.jsonl"))
# Same rule as wts-api.py: a worktree folder ends with the session timestamp.
SESSION_RE = re.compile(r"-(\d{8}-\d{6})(?:/|$)")


def main() -> int:
    try:
        event = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        print(f"notify-inbox: invalid hook input ({exc})", file=sys.stderr)
        return 1
    cwd = event.get("cwd", "")
    m = SESSION_RE.search(cwd)
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "session": m.group(1) if m else "",
        "cwd": cwd,
        "claudeSession": event.get("session_id", ""),
        "type": event.get("notification_type", ""),
        "message": event.get("message", ""),
    }
    INBOX_FILE.parent.mkdir(parents=True, exist_ok=True)
    with INBOX_FILE.open("a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
