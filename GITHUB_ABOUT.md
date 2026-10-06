# Repository metadata

Copy-paste text for the GitHub repository settings.

> These fields are not stored in the repository, so `git push` cannot apply them.
> To set them automatically, run
> `.\scripts\set-repo-metadata.ps1 -Repo "YOUR_USERNAME/Custom-Twitch-Review-Requests"`
> — it also reads the values back to confirm they were stored.

---

## Repository name

```
Custom-Twitch-Review-Requests
```

## About — short description

GitHub truncates this field at about 350 characters, so keep it tight:

```
Chrome extension for Twitch: search a viewer's channel points reward-queue claims and refund points for individual claims. No API keys, no permissions, no bulk actions.
```

A slightly shorter variant, if you prefer:

```
Search a viewer's channel points claims in Twitch's reward queue and refund individual claims. No API keys, no permissions, no bulk refunds.
```

## Topics

Paste these into the **Topics** field, one at a time (GitHub lowercases them
automatically):

```
twitch
twitch-extension
chrome-extension
manifest-v3
channel-points
twitch-api
moderation
streamer-tools
javascript
```

## Website

Leave empty. There is no homepage, and a dead link looks worse than none.

## Social preview

Upload a 1280x640 image. The panel screenshot works well here — crop it so the
panel fills the frame. Blur viewer names first if you consider them private.

---

## Suggested first release

- **Tag:** `v1.0.0`
- **Release title:** `v1.0.0 — first public release`
- **Description:** paste the `v1.0.0` section from [RELEASE_NOTES.md](RELEASE_NOTES.md)
- **Asset:** a ZIP of the `dist` folder, named `dist.zip`, so users can install
  without cloning

To build the asset:

```powershell
Compress-Archive -Path dist\* -DestinationPath dist.zip -Force
```

---

## Pinned repository description for the first commit message

```
Custom Twitch Review Requests 1.0.0

Chrome extension that reads a Twitch channel points reward queue, searches
claims by viewer and refunds points for individual claims.

- Manifest V3, zero permissions, no API keys
- two-column panel mirroring Twitch's own reward queue
- one refund button per claim, confirmation on by default
- no bulk or background operations
```

---

## A note on what NOT to publish

The `.gitignore` already excludes these, but double-check before the first push:

- `www.twitch.tv.har` and any `*.har` — network dumps contain the
  `authorization` header, `x-device-id` and `client-integrity` values.
- `recon/` — reconnaissance material with real viewer logins, claim ids and
  queue statistics from a specific channel.
- `ТЗ.md` — the original specification, written for one client.
- `NOTES.md` — internal development notes with queue statistics.

Run `git status` before committing. The repository was initialised by the author
and the first commit contains exactly **22 files**:

```
.gitattributes                                dist/content.css
.gitignore                                    dist/content.js
.github/ISSUE_TEMPLATE/bug_report.md          dist/icons/icon16.png
GITHUB_ABOUT.md                               dist/icons/icon48.png
LICENSE                                       dist/icons/icon128.png
README.md                                     dist/injected.js
RELEASE_NOTES.md                              dist/manifest.json
build.mjs                                     src/extension/content.css
scripts/README.md                             src/extension/content.js
scripts/set-repo-metadata.ps1                 src/extension/injected.js
                                              src/extension/manifest.json
                                              src/extension/icons/icon16.png
                                              src/extension/icons/icon48.png
                                              src/extension/icons/icon128.png
```

Both `src/extension/` and `dist/` are committed on purpose: `dist/` is the
installable release users download, and `src/extension/` is the source they can
read. `build.mjs` guarantees the two are identical — it is worth running it
before each commit that touches the sources.

This file (`GITHUB_ABOUT.md`) is only useful to maintainers. If you would rather
keep the repository focused on the extension, it can be deleted or moved to the
repository wiki after the release metadata has been filled in.

