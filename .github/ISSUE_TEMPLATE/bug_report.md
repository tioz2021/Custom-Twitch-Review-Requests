---
name: Bug report
about: Something in the extension does not work as expected
title: "[Bug] "
labels: bug
---

<!--
Thanks for taking the time to report a problem.

Please do NOT paste your OAuth token, authorization header, client-integrity
value or a full HAR file. If you need to share network data, redact those
headers first — they grant full access to your Twitch account.
-->

## What happened

<!-- A clear description of the problem. -->

## What you expected

<!-- What should have happened instead. -->

## Steps to reproduce

1.
2.
3.

## Does it happen every time?

- [ ] Yes, every time
- [ ] No, only sometimes
- [ ] Happened once

## Extension version

<!-- Shown in the panel header, e.g. v2026-10-07.10 -->

## Where it breaks

<!-- Tick everything that applies. -->

- [ ] The panel does not appear at all
- [ ] The panel appears but the queue never finishes loading
- [ ] Search by viewer returns nothing for a viewer I know has claims
- [ ] Claims are shown but grouped under the wrong reward
- [ ] Refund button does nothing
- [ ] Refund fails with an error message
- [ ] Refund reports success but the points were not returned
- [ ] Layout problem (columns, scrolling, collapsing)
- [ ] Something else

## Diagnostics output

<!--
The panel has a "Diagnostics" button in its header. Click it and paste the
result here — it tests one request against Twitch and reports which parts of
the handshake work. Please redact any token-like values it prints.
-->

```

```

## Console errors

<!--
Open DevTools (F12) -> Console, then reload the reward queue page. Paste any
messages whose text starts with [points-return].
-->

```

```

## Environment

- Browser and version (e.g. Chrome 154):
- Operating system:
- Are you the channel owner or a moderator?:
- Roughly how many claims are in the queue?:
- Did it work before, and if so, which version?:

## Anything else

<!-- Screenshots are welcome. Please blur viewer names and claim IDs if you
     consider them private. -->
