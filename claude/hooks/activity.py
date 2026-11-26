#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Terry Cornelusse
"""Claude Code hook: record what the Claude of each Worktree Station session is doing now.

The dashboard shows "working" or "waiting" on a session's card from this file, so a card says
whether a Claude is busy right now, not only that one ran there once.

    UserPromptSubmit, PostToolUse -> working  (PostToolUse: a permission was granted, work resumed)
    Notification                  -> waiting  (a permission or an answer is expected)
    Stop                          -> idle     (the turn is over)
    SessionEnd                    -> entry removed

A session outside a worktree (no session timestamp in its folder) is ignored.
"""
import fcntl
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("WTS_CONFIG_DIR", Path.home() / ".config" / "wts"))
ACTIVITY_FILE = Path(os.environ.get("WTS_ACTIVITY_FILE", CONFIG_DIR / "activity.json"))
# Same rule as wts-api.py: a worktree folder ends with the session timestamp.
SESSION_RE = re.compile(r"-(\d{8}-\d{6})(?:/|$)")
STATES = {
    "UserPromptSubmit": "working",
    "PostToolUse": "working",
    "Notification": "waiting",
    "Stop": "idle",
    "SessionEnd": None,
}


def read(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError:
        # A torn file would hide every session: start again from the events to come.
        print(f"activity: {path} unreadable, rewritten", file=sys.stderr)
        return {}


def main() -> int:
    try:
        event = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        print(f"activity: invalid hook input ({exc})", file=sys.stderr)
        return 1
    name = event.get("hook_event_name", "")
    m = SESSION_RE.search(event.get("cwd", ""))
    if name not in STATES or not m:
        return 0
    session, state = m.group(1), STATES[name]

    ACTIVITY_FILE.parent.mkdir(parents=True, exist_ok=True)
    # Several sessions write this file at once: one writer at a time, then an atomic replace.
    with open(ACTIVITY_FILE.with_suffix(".lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = read(ACTIVITY_FILE)
        current = data.get(session, {}).get("state")
        if state is None:
            if session not in data:
                return 0
            del data[session]
        elif current == state:
            # PostToolUse fires on every tool call: write only when the state changes.
            return 0
        else:
            data[session] = {
                "state": state,
                "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "claudeSession": event.get("session_id", ""),
            }
        tmp = ACTIVITY_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2) + "\n")
        os.replace(tmp, ACTIVITY_FILE)
    return 0


if __name__ == "__main__":
    sys.exit(main())
