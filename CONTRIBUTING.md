# Contributing to Worktree Station

Thanks for your interest! Issues and pull requests are welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on
  the approach.
- Be kind: this project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- Never report a security issue in a public issue — see [SECURITY.md](SECURITY.md).

## Licensing of contributions

Worktree Station is licensed under the
[GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`).
By submitting a contribution, you agree that it is licensed under the same
terms ("inbound = outbound"), and you certify the
[Developer Certificate of Origin 1.1](https://developercertificate.org/): you
wrote the change, or otherwise have the right to submit it under this license.

Certify it by signing off every commit:

```sh
git commit -s -m "Describe the change"
```

which adds a `Signed-off-by: Your Name <you@example.com>` line. Pull requests
with unsigned commits cannot be merged.

## Development

```sh
./install.sh --dry-run                       # what the installer would change
zsh -n bin/wts && bash -n install.sh         # shell syntax
cd vscode-extension/worktree-station
npm install && npx tsc --noEmit -p .         # type check
npm run package                              # build the .vsix
```

Conventions:

- Everything is written in English: code, comments, messages, docs, commits.
- Keep it generic: no company names, personal paths or machine-specific values
  in the repo — those belong in `~/.config/wts/config.sh`.
- New source files start with the SPDX header:

  ```
  SPDX-License-Identifier: AGPL-3.0-only
  Copyright (C) 2026 Terry Cornelusse
  ```

- The extension reimplements nothing: new behaviour goes into the `wts` CLI
  first, and the extension calls it.
