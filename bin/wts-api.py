#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Terry Cornelusse
"""wts JSON API — consumed by the Worktree Station VS Code extension.

No writes, no side effects: only reads git / dbt state.
Mutations go through the `wts` CLI itself.

Usage :
    wts-api.py sessions        worktree state, grouped by session
    wts-api.py repos           state of the main clones
    wts-api.py changed <dir>   dbt models changed in <dir> vs its base branch
    wts-api.py config          resolved paths (python, dbt, root…)
"""
import json
import os
import re
import subprocess
import sys
import time

DOTFILES = os.environ.get("DOTFILES", os.path.expanduser("~/.dotfiles"))
BUSY_WINDOW_H = 8
# Folders that change without a human touching the code: they must not make a
# worktree look "busy".
PRUNE_DIRS = {".git", "target", "dbt_packages", "logs", "venv",
              "node_modules", "__pycache__", ".pytest_cache", "state"}


def sh(args, cwd=None, timeout=15):
    try:
        p = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return p.stdout.strip() if p.returncode == 0 else ""
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return ""


def load_config():
    """Read lib/config.sh through zsh: a single source of truth, no duplication."""
    script = (
        f'source "{DOTFILES}/lib/config.sh" 2>/dev/null || exit 1\n'
        'print -r -- "root=$WTS_ROOT"\n'
        'print -r -- "worktrees=$WTS_WORKTREE_DIR"\n'
        'print -r -- "python=$WTS_PYTHON"\n'
        'print -r -- "dbt=$WTS_DBT"\n'
        'print -r -- "sqlfluff=$WTS_SQLFLUFF"\n'
        'print -r -- "venv=$WTS_VENV"\n'
        'for e in $WTS_REPOS; do print -r -- "repo=$e"; done\n'
    )
    out = sh(["zsh", "-c", script])
    cfg = {"repos": []}
    for line in out.splitlines():
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        if k == "repo":
            parts = v.split(":")
            if len(parts) >= 3:
                cfg["repos"].append({"name": parts[0], "base": parts[1], "kind": parts[2],
                                     "path": parts[3] if len(parts) > 3 else ""})
        else:
            cfg[k] = v
    for repo in cfg["repos"]:
        repo["dir"] = repo["path"] or os.path.join(cfg.get("root", ""), repo["name"])
    return cfg


# ── git ───────────────────────────────────────────────────────────────────────
def git(cwd, *args, timeout=15):
    return sh(["git", "-C", cwd, *args], timeout=timeout)


def worktree_entries(repo):
    """git worktree list --porcelain → [(path, branch)]"""
    out = git(repo, "worktree", "list", "--porcelain")
    entries, path, branch = [], None, ""
    for line in out.splitlines():
        if line.startswith("worktree "):
            if path:
                entries.append((path, branch))
            path, branch = line[9:], ""
        elif line.startswith("branch "):
            branch = line[7:].replace("refs/heads/", "")
    if path:
        entries.append((path, branch))
    return entries


def recently_touched(root, max_h=BUSY_WINDOW_H):
    """Was a tracked file modified within the window? Returns on the first hit."""
    cutoff = time.time() - max_h * 3600
    stack, seen = [root], 0
    while stack:
        d = stack.pop()
        try:
            with os.scandir(d) as it:
                for e in it:
                    seen += 1
                    if seen > 20000:      # safeguard: a huge repo must not block the UI
                        return False
                    if e.is_dir(follow_symlinks=False):
                        if e.name not in PRUNE_DIRS and not e.name.startswith(".") and not e.name.endswith("_venv"):
                            stack.append(e.path)
                    elif e.is_file(follow_symlinks=False):
                        try:
                            if e.stat(follow_symlinks=False).st_mtime > cutoff:
                                return True
                        except OSError:
                            continue
        except (PermissionError, FileNotFoundError, OSError):
            continue
    return False


def git_state(path, base_hint=""):
    """Full state of a checkout: cleanliness, ahead/behind, base, remote."""
    st = {
        "path": path,
        "name": os.path.basename(path),
        "exists": os.path.isdir(path),
        "branch": "", "base": base_hint, "dirty": 0, "ahead": 0, "behind": 0,
        "hasUpstream": False, "remoteUrl": "", "repoSlug": "",
        "busy": False, "reason": "",
    }
    if not st["exists"]:
        st["busy"], st["reason"] = False, "folder missing"
        return st

    st["branch"] = git(path, "rev-parse", "--abbrev-ref", "HEAD")
    porcelain = git(path, "status", "--porcelain")
    st["dirty"] = len([l for l in porcelain.splitlines() if l.strip()])

    url = git(path, "remote", "get-url", "origin")
    st["remoteUrl"] = url
    m = re.search(r"[:/]([^/:]+/[^/]+?)(?:\.git)?$", url)
    if m:
        st["repoSlug"] = m.group(1)

    upstream = git(path, "rev-parse", "--abbrev-ref", "@{upstream}")
    if upstream:
        st["hasUpstream"] = True
        counts = git(path, "rev-list", "--left-right", "--count", "@{upstream}...HEAD")
        if counts:
            parts = counts.split()
            if len(parts) == 2:
                st["behind"], st["ahead"] = int(parts[0]), int(parts[1])
    else:
        ref = base_hint or git(path, "for-each-ref", "--format=%(refname:short)",
                               "refs/remotes/origin/HEAD") or "origin/HEAD"
        if not ref.startswith("origin/"):
            ref = f"origin/{ref}"
        n = git(path, "rev-list", "--count", f"{ref}..HEAD")
        st["ahead"] = int(n) if n.isdigit() else 0

    # Same rules as wts_wt_busy: never delete anything that carries work.
    if st["dirty"]:
        st["busy"], st["reason"] = True, f"{st['dirty']} changed file(s)"
    elif st["ahead"]:
        st["busy"], st["reason"] = True, f"{st['ahead']} unpushed commit(s)"
    elif recently_touched(path):
        st["busy"], st["reason"] = True, f"touched less than {BUSY_WINDOW_H} h ago"
    else:
        st["reason"] = "removable"
    return st


def compare_url(st, base):
    if not st["repoSlug"] or not st["branch"]:
        return ""
    if not st["hasUpstream"] and not st["ahead"]:
        return ""
    return (f"https://github.com/{st['repoSlug']}/compare/"
            f"{base}...{st['branch']}?expand=1")


# ── commands ──────────────────────────────────────────────────────────────────
SESSION_RE = re.compile(r"-(\d{8}-\d{6})$")


def cmd_sessions(cfg):
    by_session, loose = {}, []
    for repo in cfg["repos"]:
        repo_dir = repo["dir"]
        if not os.path.isdir(repo_dir):
            continue
        main_real = os.path.realpath(repo_dir)
        for path, branch in worktree_entries(repo_dir):
            if os.path.realpath(path) == main_real:
                continue
            st = git_state(path, repo["base"])
            st.update(repo=repo["name"], kind=repo["kind"], mainDir=repo_dir,
                      compareUrl=compare_url(st, repo["base"]))
            m = SESSION_RE.search(os.path.basename(path))
            if m:
                by_session.setdefault(m.group(1), []).append(st)
            else:
                loose.append(st)

    sessions = []
    for sid in sorted(by_session, reverse=True):
        wts = by_session[sid]
        sessions.append({
            "id": sid,
            "label": f"{sid[6:8]}/{sid[4:6]} {sid[9:11]}:{sid[11:13]}",
            "worktrees": wts,
            "busy": any(w["busy"] for w in wts),
            "workspace": os.path.join(cfg["worktrees"], f"session-{sid}.code-workspace"),
        })
    if loose:
        sessions.append({"id": "", "label": "no session", "worktrees": loose,
                         "busy": any(w["busy"] for w in loose), "workspace": ""})
    return {"sessions": sessions}


def cmd_repos(cfg):
    out = []
    for repo in cfg["repos"]:
        d = repo["dir"]
        if not os.path.isdir(d):
            continue
        st = git_state(d, repo["base"])
        st.update(repo=repo["name"], kind=repo["kind"], isMain=True,
                  compareUrl=compare_url(st, repo["base"]))
        out.append(st)
    return {"repos": out}


def cmd_changed(cfg, path):
    """dbt models changed in this checkout vs its base branch."""
    if not path or not os.path.isdir(path):
        return {"dir": path, "models": [], "error": "folder not found"}
    root = git(path, "rev-parse", "--show-toplevel") or path

    base = ""
    for repo in cfg["repos"]:
        if os.path.basename(root).startswith(repo["name"]):
            base = f"origin/{repo['base']}"
            break
    if not base:
        base = git(root, "rev-parse", "--abbrev-ref", "@{upstream}") or "origin/HEAD"

    merge_base = git(root, "merge-base", "HEAD", base) or base
    files = set()
    for spec in (["diff", "--name-only", merge_base], ["diff", "--name-only"],
                 ["ls-files", "--others", "--exclude-standard"]):
        out = git(root, *spec)
        files.update(l for l in out.splitlines() if l.strip())

    models = []
    for f in sorted(files):
        if not f.endswith(".sql") or not f.startswith("models/"):
            continue
        full = os.path.join(root, f)
        models.append({
            "name": os.path.basename(f)[:-4],
            "file": f,
            "path": full,
            "exists": os.path.isfile(full),
            "layer": f.split("/")[1] if len(f.split("/")) > 2 else "",
        })
    return {"dir": root, "base": base, "models": models}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: wts-api.py sessions|repos|changed <dir>|config"}))
        return 2
    cfg = load_config()
    if not cfg.get("root"):
        print(json.dumps({"error": f"lib/config.sh unreadable in {DOTFILES}"}))
        return 1

    cmd = sys.argv[1]
    if cmd == "sessions":
        payload = cmd_sessions(cfg)
    elif cmd == "repos":
        payload = cmd_repos(cfg)
    elif cmd == "changed":
        payload = cmd_changed(cfg, sys.argv[2] if len(sys.argv) > 2 else "")
    elif cmd == "config":
        payload = cfg
    else:
        print(json.dumps({"error": f"unknown command: {cmd}"}))
        return 2
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
