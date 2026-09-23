# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Terry Cornelusse
# ── Secrets ───────────────────────────────────────────────────────────────────
# Never a plaintext key in the versioned dotfiles.
# Expected file: ~/.config/wts/secrets.env  (chmod 600)
_WTS_SECRETS="$HOME/.config/wts/secrets.env"
if [ -r "$_WTS_SECRETS" ]; then
  # refuse to load a world-readable file
  if [ "$(stat -f '%OLp' "$_WTS_SECRETS")" != "600" ]; then
    print -u2 "⚠️  $_WTS_SECRETS is not chmod 600 — secrets not loaded"
  else
    set -a; source "$_WTS_SECRETS"; set +a
  fi
fi
unset _WTS_SECRETS
