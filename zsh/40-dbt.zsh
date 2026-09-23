# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Terry Cornelusse
# ── dbt ───────────────────────────────────────────────────────────────────────
# The real commands live in `wts dbt ...` (see ~/.dotfiles/bin/wts).
# These aliases are just typing shortcuts.
alias dbt-run='wts dbt run'
alias dbt-build='wts dbt build'
alias dbt-test='wts dbt test'
alias dbt-show='wts dbt show'
alias dbt-parse='wts dbt parse'
alias dbt-fmt='wts fmt'

# Build the model matching the current file/dir (handy outside VS Code)
dbtm() { wts dbt build "$(basename "${1:-$PWD}" .sql)"; }
