#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Terry Cornelusse
# Installs the symlinks and the configuration. Idempotent: safe to re-run.
#   ./install.sh            install
#   ./install.sh --dry-run  show what would be done, touch nothing
set -uo pipefail

DOTFILES="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VSCODE_USER="$HOME/Library/Application Support/Code/User"
SECRETS="$HOME/.config/wts/secrets.env"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
STAMP="$(date +%Y%m%d-%H%M%S)"
DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m~\033[0m %s\n' "$*"; }
err()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; }
run()  { if (( DRY )); then printf '   \033[2m$ %s\033[0m\n' "$*"; else eval "$@"; fi; }

# link <source-in-dotfiles> <destination>
# Backs up an existing real file before replacing it. Leaves an already-correct link alone.
link() {
  local src="$1" dst="$2"
  if [[ -L "$dst" && "$(readlink "$dst")" == "$src" ]]; then
    ok "${dst/#$HOME/~} already linked"; return
  fi
  if [[ -e "$dst" && ! -L "$dst" ]]; then
    run "mv '$dst' '$dst.backup-$STAMP'"
    warn "${dst/#$HOME/~} backed up as ${dst##*/}.backup-$STAMP"
  fi
  run "mkdir -p '$(dirname "$dst")'"
  run "ln -sfn '$src' '$dst'"
  ok "${dst/#$HOME/~} → ${src/#$HOME/~}"
}

printf '\n\033[1m── Shell ─────────────────────────────────\033[0m\n'
link "$DOTFILES/zsh/zshrc" "$HOME/.zshrc"

printf '\n\033[1m── VS Code ───────────────────────────────\033[0m\n'
if [[ -d "$VSCODE_USER" ]]; then
  for f in settings.json keybindings.json tasks.json; do
    link "$DOTFILES/vscode/$f" "$VSCODE_USER/$f"
  done
  # File by file, not the folder: VS Code writes its own snippets in there.
  for snip in "$DOTFILES"/vscode/snippets/*.code-snippets; do
    link "$snip" "$VSCODE_USER/snippets/$(basename "$snip")"
  done
else
  err "VS Code not found ($VSCODE_USER) — editor layer skipped"
fi

printf '\n\033[1m── Secrets ───────────────────────────────\033[0m\n'
if [[ -f "$SECRETS" ]]; then
  ok "${SECRETS/#$HOME/~} already exists"
else
  run "mkdir -p '$(dirname "$SECRETS")'"
  if (( ! DRY )); then
    cat > "$SECRETS" <<'SECEOF'
# Local secrets — never versioned, never shared.
# Loaded automatically by ~/.dotfiles/zsh/10-secrets.zsh (requires chmod 600).
# export OPENROUTER_API_KEY="..."
SECEOF
  fi
  run "chmod 600 '$SECRETS'"
  ok "${SECRETS/#$HOME/~} created (fill it in)"
fi
if [[ -f "$SECRETS" ]] && [[ "$(stat -f '%OLp' "$SECRETS")" != "600" ]]; then
  run "chmod 600 '$SECRETS'"
  warn "permissions fixed to 600"
fi

printf '\n\033[1m── Claude Code ───────────────────────────\033[0m\n'
if [[ -f "$CLAUDE_SETTINGS" ]]; then
  if (( DRY )); then
    printf '   \033[2m$ python3 bin/merge-claude-hook.py (dry-run)\033[0m\n'
  else
    python3 "$DOTFILES/bin/merge-claude-hook.py" "$CLAUDE_SETTINGS" "$DOTFILES" "$STAMP"
  fi
else
  err "$CLAUDE_SETTINGS not found — hook not installed"
fi

printf '\n\033[1m── Misc ──────────────────────────────────\033[0m\n'
run "mkdir -p '$HOME/worktrees'"; ok "~/worktrees"
if (( ! DRY )); then
  python3 "$DOTFILES/bin/build-profile.py" "$DOTFILES" >/dev/null && ok "VS Code profile generated"
fi

printf '\n\033[1m── Extension VS Code ─────────────────────\033[0m\n'
EXT_DIR="$DOTFILES/vscode-extension/worktree-station"
if ! command -v code >/dev/null 2>&1; then
  err "'code' command not in PATH — extension not installed"
elif ! command -v npm >/dev/null 2>&1; then
  err "npm missing — extension not built"
elif (( DRY )); then
  printf '   \033[2m$ (cd %s && npm ci && npm run package && code --install-extension)\033[0m\n' "$EXT_DIR"
else
  # npm ci fails without a package-lock.json: fall back to npm install.
  if [[ -f "$EXT_DIR/package-lock.json" ]]; then
    ( cd "$EXT_DIR" && npm ci --silent ) >/dev/null 2>&1 || ( cd "$EXT_DIR" && npm install --silent ) >/dev/null 2>&1
  else
    ( cd "$EXT_DIR" && npm install --silent ) >/dev/null 2>&1
  fi
  if ( cd "$EXT_DIR" && npm run package --silent ) >/dev/null 2>&1; then
    if code --install-extension "$EXT_DIR/worktree-station.vsix" --force >/dev/null 2>&1; then
      ok "Worktree Station extension installed"
    else
      err "VS Code refused to install the extension"
    fi
  else
    err "extension build failed — run 'npm run package' in $EXT_DIR"
  fi
fi

printf '\n\033[1m── Diagnostics ───────────────────────────\033[0m\n'
if (( DRY )); then
  printf '   \033[2m$ wts doctor\033[0m\n'
else
  PATH="$DOTFILES/bin:$PATH" DOTFILES="$DOTFILES" zsh "$DOTFILES/bin/wts" doctor
fi

printf '\n\033[1mOpen a new terminal (or run `exec zsh`) to load the config.\033[0m\n'
