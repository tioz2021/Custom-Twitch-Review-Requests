# Helper scripts

These scripts are for maintaining the public repository. They are not part of
the extension and are never shipped in `dist/`.

## `set-repo-metadata.ps1`

Sets the GitHub **About** description and the repository **Topics**.

Why a script is needed: both fields live in GitHub's repository settings, not in
the repository itself, so `git push` cannot carry them and there is no file in
which to store them. This script applies them through the GitHub API in one step
and then reads them back to confirm what was actually stored.

```powershell
# 1. Create a token: https://github.com/settings/tokens
#    A classic token with the `public_repo` scope is enough for a public repo.
# 2. Run:
.\scripts\set-repo-metadata.ps1 -Repo "YOUR_USERNAME/Custom-Twitch-Review-Requests"
```

The token is read with `Read-Host -AsSecureString`, used once, held only in
memory and never written to disk. `GITHUB_ABOUT.md` holds the same text for
copy-paste, in case you prefer to fill the fields in the browser.
