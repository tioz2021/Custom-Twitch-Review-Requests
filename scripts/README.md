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
powershell -ExecutionPolicy Bypass -File .\scripts\set-repo-metadata.ps1 `
    -Repo "YOUR_USERNAME/Custom-Twitch-Review-Requests"
```

Windows blocks `.ps1` files by default with the message *"running scripts is
disabled on this system"*. That is a machine-wide policy, not a fault in the
script. `-ExecutionPolicy Bypass` relaxes it for that single process only;
`Set-ExecutionPolicy RemoteSigned` would instead enable script execution
system-wide, which this task does not need.

The token is read with `Read-Host -AsSecureString`, used once, held only in
memory and never written to disk.

The description text and the topic list are parameters of the script with
sensible defaults, so it can be re-run after the repository is renamed or if the
settings are ever reset. To use different values:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\set-repo-metadata.ps1 `
    -Repo "OWNER/REPO" `
    -Description "Your own description" `
    -Topics twitch, chrome-extension
```
