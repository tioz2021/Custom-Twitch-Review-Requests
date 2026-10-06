# Release notes

Paste the section for the version you are publishing into the GitHub Release
description. The release itself is the `dist` folder — attach it as a ZIP so
users do not have to clone the repository.

---

## v1.0.0 — first public release

### What it does

A Chrome extension for Twitch streamers who have let their channel points
reward queue grow out of hand. It reads the whole queue once, lets you search
by viewer, groups the result by reward, and refunds points for individual
claims.

Twitch's own panel shows every claim on the channel in a flat list of 50 per
page and cannot search by viewer. With a few thousand unfulfilled claims,
answering "what did this viewer buy, and what needs refunding?" means paging
through the entire queue by hand. This extension does that part for you.

### Highlights

- **Search by viewer** — every unfulfilled claim of that viewer, across all
  rewards.
- **Two-column layout**, like Twitch's own panel: rewards with claim counts on
  the left, the claims of the selected reward on the right.
- **Refund a single claim** with one button per row. The refund uses the same
  request as Twitch's own `Reject` button.
- **Confirmation before refunding**, on by default, switchable in the header.
  A refund is irreversible.
- **Reads the entire queue**, working around the 50-per-page limit and the
  truncated "100+" counters.

### Safety

- Requests **no permissions at all** (`permissions: []`).
- **No API keys and no app registration** — it uses the session you already
  have open in the browser.
- **Never stores or transmits your token.** Authorization headers are read off
  the page's own requests in memory and are not persisted.
- **No bulk operations.** There is no "refund everything" and no background
  refunding. Every claim is refunded by a separate explicit click, and each
  one is protected against being refunded twice.
- **Does not mark claims as fulfilled.**

### Installation

1. Download `dist.zip` from the assets below and unzip it.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the unzipped `dist` folder.

### Requirements

- Google Chrome (or another Chromium-based browser) with Manifest V3 support.
- A Twitch account that owns the channel or moderates it with permission to
  manage channel points rewards.

### Known limitations

- **Twitch may change its internal API.** The extension uses the same internal
  GraphQL interface the Twitch panel itself uses, not the public API. If Twitch
  changes it, the extension may stop working until it is updated. This is the
  most likely reason it would break.
- **Points totals are not calculated.** A claim does not carry its cost, and
  some claims reference rewards that no longer exist, so a computed total would
  be approximate. An approximate total is worse than none: you could refund
  less than the viewer spent without noticing. The panel therefore shows the
  exact claim list and count, and you count the points yourself.
- **Not published in the Chrome Web Store**, so it must be installed in
  developer mode.
