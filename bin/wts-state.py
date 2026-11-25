#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Terry Cornelusse
"""Board state and inbox shared by the wts CLI, the VS Code extension and any agent.

The state lives in a plain file, not in VS Code's globalState, so that a process
outside VS Code (a script, an agent) can read and change it.

Usage:
    wts-state.py show                      state as JSON
    wts-state.py card <session> <column>   move a session to a column
    wts-state.py name <session> [name]     name a session (no name: back to its timestamp)
    wts-state.py columns <id>=<label>...   replace the columns, in order
    wts-state.py inbox [--json] [--clear]  notifications written by the Claude Code hook
"""
import json
import os
import sys
import tempfile
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("WTS_CONFIG_DIR", Path.home() / ".config" / "wts"))
STATE_FILE = Path(os.environ.get("WTS_STATE_FILE", CONFIG_DIR / "state.json"))
INBOX_FILE = Path(os.environ.get("WTS_INBOX_FILE", CONFIG_DIR / "inbox.jsonl"))

DEFAULT_COLUMNS = [
    {"id": "prep", "label": "Preparation"},
    {"id": "wip", "label": "In progress"},
    {"id": "uat", "label": "UAT"},
]


def load() -> dict:
    try:
        data = json.loads(STATE_FILE.read_text())
    except FileNotFoundError:
        data = {}
    data.setdefault("columns", DEFAULT_COLUMNS)
    data.setdefault("board", {})
    data.setdefault("names", {})
    return data


def save(data: dict) -> None:
    """Atomic replace: the extension watches the file and must never read half of it."""
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=STATE_FILE.parent, prefix=".state-", suffix=".json")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, STATE_FILE)


def fail(msg: str) -> int:
    print(f"wts-state: {msg}", file=sys.stderr)
    return 1


def cmd_card(args: list[str]) -> int:
    if len(args) != 2:
        return fail("usage: card <session> <column>")
    sid, column = args
    data = load()
    ids = [c["id"] for c in data["columns"]]
    if column not in ids:
        return fail(f"unknown column {column!r}; columns: {', '.join(ids)}")
    data["board"][sid] = column
    save(data)
    return 0


def cmd_name(args: list[str]) -> int:
    if not args:
        return fail("usage: name <session> [name]")
    sid, name = args[0], " ".join(args[1:]).strip()
    data = load()
    if name:
        data["names"][sid] = name
    else:
        data["names"].pop(sid, None)
    save(data)
    return 0


def cmd_columns(args: list[str]) -> int:
    cols = []
    for a in args:
        cid, sep, label = a.partition("=")
        if not sep or not cid or not label:
            return fail(f"bad column {a!r}: expected <id>=<label>")
        cols.append({"id": cid, "label": label})
    if not cols:
        return fail("usage: columns <id>=<label>...")
    data = load()
    data["columns"] = cols
    # A session whose column disappeared falls back to the first column when read.
    data["board"] = {s: c for s, c in data["board"].items() if c in {x["id"] for x in cols}}
    save(data)
    return 0


def cmd_inbox(args: list[str]) -> int:
    entries = []
    if INBOX_FILE.exists():
        for n, line in enumerate(INBOX_FILE.read_text().splitlines(), 1):
            if not line.strip():
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError as exc:
                return fail(f"{INBOX_FILE}:{n} is not JSON ({exc})")
    if "--json" in args:
        print(json.dumps(entries, indent=2, ensure_ascii=False))
    else:
        for e in entries:
            where = e.get("session") or e.get("cwd", "?")
            print(f"{e.get('ts', '?')}  {where}  {e.get('type', '')}  {e.get('message', '')}")
        if not entries:
            print("inbox empty")
    if "--clear" in args and INBOX_FILE.exists():
        INBOX_FILE.unlink()
    return 0


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] in {"-h", "--help", "help"}:
        print(__doc__)
        return 0
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "show":
        print(json.dumps(load(), indent=2, ensure_ascii=False))
        return 0
    handlers = {"card": cmd_card, "name": cmd_name, "columns": cmd_columns, "inbox": cmd_inbox}
    if cmd not in handlers:
        return fail(f"unknown command {cmd!r}")
    return handlers[cmd](args)


if __name__ == "__main__":
    sys.exit(main())
