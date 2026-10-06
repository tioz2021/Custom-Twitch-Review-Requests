# Custom Twitch Review Requests

A Chrome extension that helps a Twitch streamer work through the channel points
reward queue: find every claim made by one viewer, see them grouped by reward,
and refund points for individual claims — without paging through dozens of
screens by hand.

## Why this exists

Twitch's own reward queue shows **every** claim on the channel in a flat list of
50 per page and cannot search by viewer. Once a channel accumulates thousands of
unfulfilled claims, a simple question — "what did this viewer buy from me, and
what of it needs refunding?" — becomes practically unanswerable. You would have
to page through the entire queue and remember where each viewer's claims were.

This extension does that work for you: the panel reads the whole queue, searches
by viewer name and groups the results by reward. After that, it is one button
per claim.

## Features

- **Search by viewer** — every unfulfilled claim of that viewer, across all
  rewards.
- **Two columns, like Twitch's own panel** — rewards with claim counts on the
  left, the claims of the selected reward on the right.
- **Refund a single claim** — a button on every row. The refund uses exactly the
  same request as Twitch's own `Reject` button (whose tooltip reads
  "Refund points back").
- **Confirmation before refunding** — on by default, can be switched off in the
  header. A refund is irreversible, so leaving it on is recommended.
- **Reads the whole queue** — works around the panel's 50-per-page limit and the
  truncated "100+" counters.

## What it does not do

- **It does not use the Twitch API** and requires no app registration.
- **It requests no permissions at all** (`permissions: []`) and has no access to
  your tabs, history or bookmarks.
- **It never stores or transmits your token** — authorization headers are taken
  from the Twitch page at request time and are never saved.
- **It performs no bulk operations.** There is no "refund everything" and no
  background refunding: every claim is refunded by a separate explicit click.
- **It does not mark claims as fulfilled** — that button does not exist here.

## Installation

The extension is not published in the Chrome Web Store, so it is installed in
developer mode. This is a standard, safe procedure as long as you understand
what you are loading.

1. Download the **`dist`** folder from this repository (green `Code` button →
   `Download ZIP`, then unzip).
2. Open `chrome://extensions`.
3. Turn on **Developer mode** in the top right corner.
4. Click **Load unpacked** and select the `dist` folder.

## Usage

1. Open your channel's reward queue panel:
   `https://www.twitch.tv/popout/<your_channel>/reward-queue`
2. The panel appears at the top and reads the whole queue once. On a channel with
   several thousand claims this takes a few seconds — the counter at the bottom
   shows how much has been read.
3. Type a viewer name and click **Find**.
4. The rewards that viewer has claims in appear on the left. Click one and its
   claims open on the right.
5. Every claim has a **Refund points** button. Clicking it returns the points to
   the viewer for that claim.

The **Collapse** button in the header shrinks the panel to a single line so you
can work in Twitch's own interface. **Expand** brings it back.

## Things you should know

- **Refunding points cannot be undone.** Neither this extension nor Twitch can
  reverse a refund. That is why the extension asks for confirmation before every
  action.
- **Refunds are made by your account.** The extension acts on behalf of your
  session, so you must be the channel owner or a moderator with permission to
  manage rewards.
- **Twitch may change its internal API.** The extension talks to the same
  interface the Twitch panel itself uses, not to the public API. If Twitch
  changes it, the extension may stop working until it is updated.
- **This is not an official Twitch tool.** Use it at your own risk and in
  accordance with Twitch's terms of service.

## How it works

```
dist/
├── manifest.json     extension manifest (Manifest V3, no permissions)
├── content.js        UI, queue reading, viewer search, refunding
├── injected.js       captures page headers and replays requests
├── content.css       panel styling
└── icons/            16/48/128 icons
```

The split into two files is not accidental. `injected.js` runs in the page
context (MAIN world) and can do what an extension cannot: read authorization
headers off Twitch's real requests. `content.js` runs in the extension's isolated
world, draws the panel and talks to `injected.js` over `window.postMessage`. That
is why the extension needs neither permissions nor a token of its own.

## Development

```
src/extension/     extension sources
dist/              ready-to-install release (built from src)
build.mjs          release build with a personal-data check
```

After changing the sources, build the release:

```
node build.mjs
```

The script copies the files from `src/extension/` into `dist/` and **verifies
that no personal data reached the release** — tokens, channel ids, authorization
header values. The check is not cosmetic: the build fails if it finds anything,
because an accidentally published OAuth token means a compromised account.

Notes from working on this codebase:

- **Do not declare `content.css` in the manifest.** Chrome caches a stylesheet
  declared there and never re-reads it after the extension is updated, so the
  browser ends up running a new `content.js` against an old CSS file. That is why
  the stylesheet is injected by script with a version marker in its URL.
- **Do not add `display` to the defensive CSS reset.** The reset exists to
  protect typography from Twitch's global styles. Adding `display: revert` there
  makes it override your own `display: flex` rules — the specificity matches and
  the reset comes first in the file.

## License

MIT — see [LICENSE](LICENSE).
