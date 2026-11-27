#!/usr/bin/env zsh
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Terry Cornelusse
# `wts claude --brief`: checks the vscode:// link and the pending brief, with a fake `open` that
# records the link instead of reaching VS Code. Nothing starts Claude.
#   zsh tests/wts-claude-brief.zsh
emulate -L zsh
setopt pipefail

ROOT="${0:A:h:h}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/home"
# Stands in for the extension too: takes the brief the way claimBrief does (pending/ to used/),
# unless FAKE_DROP is set, which plays a window running an older extension.
print -r -- '#!/bin/sh
printf "%s\n" "$1" >> "$OPEN_LOG"
case "$1" in *brief=*)
  [ -n "$FAKE_DROP" ] && exit 0
  token=${1##*brief=}; sid=${1#*session=}; sid=${sid%%&*}
  d="$WTS_CONFIG_DIR/briefs"; mkdir -p "$d/used" && mv "$d/pending/$sid-$token.md" "$d/used/" ;;
esac' > "$TMP/bin/open"
chmod +x "$TMP/bin/open"

export OPEN_LOG="$TMP/open.log" WTS_CONFIG_DIR="$TMP/cfg" HOME="$TMP/home"
SID=20261127-151841
fails=0

wts() { PATH="$TMP/bin:$PATH" DOTFILES="$ROOT" zsh "$ROOT/bin/wts" "$@" >"$TMP/out" 2>"$TMP/err"; }
check() {  # label, condition (eval'd)
  if eval "$2"; then print -r -- "ok   $1"; else print -r -- "FAIL $1"; (( fails++ )); fi
}
last_uri() { tail -1 "$OPEN_LOG" 2>/dev/null; }
reset() { rm -rf "$OPEN_LOG" "$WTS_CONFIG_DIR"; }

print -r -- 'line 1
it'"'"'s "quoted" $HOME' > "$TMP/brief.md"
: > "$TMP/empty.md"
head -c 102401 /dev/zero | tr '\0' x > "$TMP/big.md"

reset; wts claude "$SID"
check "no brief: same link as before" '[[ "$(last_uri)" == "vscode://tec0r.worktree-station/claude?session=$SID" ]]'

reset; wts claude --brief "$TMP/brief.md" "$SID"
uri="$(last_uri)"
check "brief: token in the link, never the path" '[[ "$uri" =~ "^vscode://tec0r.worktree-station/claude\?session=$SID&brief=[0-9a-f]{32}$" ]]'
token="${uri##*brief=}"
used="$WTS_CONFIG_DIR/briefs/used/$SID-$token.md"
check "brief: copied as <session>-<token>.md, picked up" '[[ -f "$used" ]] && cmp -s "$used" "$TMP/brief.md"'
check "brief: picked up reported" 'grep -q "picked up" "$TMP/out"'
check "brief: file mode 600" '[[ "$(stat -f %Lp "$used")" == 600 ]]'
check "brief: pending folder mode 700" '[[ "$(stat -f %Lp "$WTS_CONFIG_DIR/briefs/pending")" == 700 ]]'

reset; wts claude --background --brief "$TMP/brief.md" "$SID"
check "background + brief: claude-background action" '[[ "$(last_uri)" == vscode://tec0r.worktree-station/claude-background\?session=$SID\&brief=* ]]'
reset; wts claude "$SID" --brief "$TMP/brief.md" --background
check "options in any order" '[[ "$(last_uri)" == vscode://tec0r.worktree-station/claude-background\?session=$SID\&brief=* ]]'

reset; wts claude --background "$SID"; rc=$?
check "background without brief: refused" '(( rc != 0 )) && [[ ! -s "$OPEN_LOG" ]] && grep -q "needs --brief" "$TMP/err"'
reset; wts claude --brief "$TMP/missing.md" "$SID"; rc=$?
check "missing brief: refused" '(( rc != 0 )) && [[ ! -s "$OPEN_LOG" ]] && grep -q "brief not found" "$TMP/err"'
reset; wts claude --brief "$TMP/empty.md" "$SID"; rc=$?
check "empty brief: refused" '(( rc != 0 )) && [[ ! -s "$OPEN_LOG" ]] && grep -q "brief is empty" "$TMP/err"'
reset; wts claude --brief "$TMP/big.md" "$SID"; rc=$?
check "brief over 100 KB: refused" '(( rc != 0 )) && [[ ! -s "$OPEN_LOG" ]] && grep -q "too large" "$TMP/err"'
reset; wts claude --brief; rc=$?
check "--brief without a file: refused" '(( rc != 0 )) && grep -q "expects a file" "$TMP/err"'
reset; wts claude-close --brief "$TMP/brief.md" "$SID"; rc=$?
check "--brief on another action: refused" '(( rc != 0 )) && [[ ! -s "$OPEN_LOG" ]] && grep -q "only applies to wts claude" "$TMP/err"'
reset; wts claude --brief "$TMP/brief.md" not-a-session; rc=$?
check "bad session: refused, nothing copied" '(( rc != 0 )) && [[ ! -d "$WTS_CONFIG_DIR/briefs/pending" ]]'
reset; wts claude-close "$SID"
check "other actions unchanged" '[[ "$(last_uri)" == "vscode://tec0r.worktree-station/claude-close?session=$SID" ]]'

reset; FAKE_DROP=1 WTS_BRIEF_WAIT=1 wts claude --background --brief "$TMP/brief.md" "$SID"; rc=$?
check "brief not picked up in time: error, nothing left pending" \
  '(( rc != 0 )) && grep -q "not picked up by VS Code in 1 s" "$TMP/err" && [[ -z "$(print -r -- "$WTS_CONFIG_DIR"/briefs/pending/*(N))" ]]'

print -r -- "$(( fails )) failure(s)"
(( fails == 0 ))
