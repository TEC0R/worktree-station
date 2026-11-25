#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Terry Cornelusse
"""Delete a whole session from the shell: its worktrees, its .code-workspace, its card.

Usage:
    wts-rm.py <session timestamp> [--force]

Refuses a session holding uncommitted or unpushed work unless --force. Windows open
on the session are asked to close through the extension's window registry, before
the folders disappear under them.

Shell only, on purpose: a vscode:// link can be opened by any web page, so deletion
is never reachable through the extension's URI handler.
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

BIN = Path(__file__).resolve().parent
CONFIG_DIR = Path(os.environ.get("WTS_CONFIG_DIR", Path.home() / ".config" / "wts"))
WINDOWS_DIR = CONFIG_DIR / "windows"
STALE_S = 90  # same as windows.ts: a window not seen for 90 s is gone


def fail(msg: str) -> int:
    print(f"wts rm: {msg}", file=sys.stderr)
    return 1


def windows_holding(paths: set) -> list:
    """Pids of live VS Code windows with one of these folders open."""
    pids = []
    if not WINDOWS_DIR.is_dir():
        return pids
    now = time.time()
    for f in WINDOWS_DIR.glob("*.json"):
        try:
            info = json.loads(f.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if now - info.get("updatedAt", 0) / 1000 > STALE_S:
            continue
        if paths & set(info.get("folders", [])):
            pids.append(info["pid"])
    return pids


def main() -> int:
    args = [a for a in sys.argv[1:] if a != "--force"]
    force = "--force" in sys.argv[1:]
    if len(args) != 1 or not re.fullmatch(r"\d{8}-\d{6}", args[0]):
        return fail("usage: wts rm <session timestamp, e.g. 20261125-110907> [--force]")
    sid = args[0]

    api = subprocess.run(
        [sys.executable, str(BIN / "wts-api.py"), "sessions"], capture_output=True, text=True, check=False
    )
    if api.returncode != 0:
        return fail(f"cannot list sessions: {api.stderr.strip()}")
    session = next((s for s in json.loads(api.stdout)["sessions"] if s["id"] == sid), None)
    if not session:
        return fail(f"no session {sid}")

    live = [w for w in session["worktrees"] if w.get("exists")]
    unsafe = [
        f"{w['repo']}: {w['dirty']} uncommitted file(s), {w['ahead']} unpushed commit(s)"
        for w in live
        if w.get("dirty") or w.get("ahead")
    ]
    if unsafe and not force:
        return fail("work would be lost, nothing deleted:\n  " + "\n  ".join(unsafe) + "\nrerun with --force to delete anyway")

    paths = {w["path"] for w in session["worktrees"]}
    pids = windows_holding(paths)
    for pid in pids:
        (WINDOWS_DIR / f"close-{pid}.request").write_text(str(int(time.time() * 1000)))
    if pids:
        print(f"asked {len(pids)} window(s) to close")
        time.sleep(2)  # let them close before their folders vanish

    errors = 0
    for w in session["worktrees"]:
        r = subprocess.run([str(BIN / "wts"), "wt", "rm", w["path"]], check=False)
        errors += r.returncode != 0
    workspace = session.get("workspace")
    if workspace and Path(workspace).exists():
        Path(workspace).unlink()
    subprocess.run([sys.executable, str(BIN / "wts-state.py"), "forget", sid], check=False)
    if errors:
        return fail(f"{errors} worktree(s) not deleted, see above")
    print(f"session {sid} deleted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
