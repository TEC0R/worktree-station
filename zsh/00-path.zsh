# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Terry Cornelusse
# ── PATH ──────────────────────────────────────────────────────────────────────
_prepend_path() { [ -d "$1" ] && PATH="$1:${PATH//$1:/}"; }
_append_path()  { [ -d "$1" ] && PATH="${PATH//:$1/}:$1"; }

_prepend_path "$DOTFILES/bin"          # wts
_prepend_path "$HOME/.local/bin"       # dbt Fusion / pipx
_prepend_path "$HOME/.mammouth/bin"
_prepend_path "$HOME/.altimate/bin"
_append_path  "$HOME/.lmstudio/bin"
export PATH
