# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Terry Cornelusse
# ── Completion ────────────────────────────────────────────────────────────────
autoload -Uz compinit && compinit -C

_wts() {
  local -a cmds
  cmds=(
    'up:full sync of the repos + worktree cleanup'
    'sync:pull + prune of the repos'
    'wt:create a session (worktrees) and open VS Code'
    'dbt:run/build/test/show/parse on a model'
    'fmt:sqlfluff fix on a file'
    'repo:manage the session repos (list/add/rm/base)'
    'lkml:LookML validation'
    'profile:build/install the VS Code profile'
    'doctor:environment diagnostics'
    'help:help'
  )
  if (( CURRENT == 2 )); then
    _describe 'command' cmds
  fi
}
compdef _wts wts 2>/dev/null
