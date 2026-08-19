---
title: Detecting YouTube Shorts and verifying channels without the Data API
date: 2026-08-19
category: design-patterns
module: youtube-integration
problem_type: design_pattern
component: api_layer
severity: medium
applies_when:
  - "Need a video's orientation (portrait Short vs landscape) from YouTube"
  - "Verifying a channel ID maps to the right channel"
  - "Checking whether a channel is actively uploading"
tags: [youtube, youtube-data-api, shorts, vertical-video, channel-verification, rss]
---

# Detecting YouTube Shorts and verifying channels without the Data API

## Context

squishy renders vertical Shorts in a portrait frame and curates a channel list.
The YouTube Data API v3 helps with neither: it exposes **no video dimensions**
(the `fileDetails` part with width/height is only returned to the video's owner),
and its `channels.list` is a quota call that still doesn't tell you if a channel
is *active*. All three needs are solvable with plain, unauthenticated web
requests — no API key, no quota.

## Guidance

**Orientation (is it a Short / vertical?) — probe the `/shorts/` URL.** A Short
serves `200` at `https://www.youtube.com/shorts/<id>`; a regular landscape video
redirects (`3xx`) to `/watch`. Follow no redirects and read the status:

```js
const res = await fetch(`https://www.youtube.com/shorts/${id}`, { redirect: 'manual' });
return res.status === 200 ? 'portrait' : 'landscape';
```

(See `scripts/lib/youtube.mjs` → `detectOrientation`; default to `'landscape'` on
any error so orientation never fails the build.)

**Verify a channel ID maps to the right channel — check its page `og:title`.** A
200 only proves the ID is *a* valid channel, not the *intended* one:

```bash
curl -s "https://www.youtube.com/channel/$ID" \
  | grep -o '<meta property="og:title"[^>]*>' | head -1
```

**Check activity/recency — read the channel RSS feed.** No key, returns the
latest ~15 uploads with dates:

```bash
curl -s "https://www.youtube.com/feeds/videos.xml?channel_id=$ID" \
  | grep -o '<published>[^<]*' | sort -r | head -1
```

## Why This Matters

Reaching for `fileDetails` (owner-only) or scraping the watch page for dimensions
is a dead end that wastes time and, if you use `search.list`, burns 100 quota
units per call. The `/shorts/` redirect, `og:title`, and RSS tricks are stable,
free, and answer the actual questions. In this build the RSS check also caught a
channel that *looked* dormant but was actually active with only long-form uploads
(filtered out by a duration cap) — a distinction the "last upload date" alone
would have hidden.

## When to Apply

- Building any curated YouTube feed where orientation or channel trust matters.
- Any time you're tempted to add a Data API call for metadata the free web
  surface already exposes.

## Examples

- Batch orientation probes with bounded concurrency during the build; store the
  result on each video so the front-end just reads it (no per-view network call).
- A 200 vs 3xx is the whole signal — no HTML parsing needed for orientation.

## Related

- `scripts/lib/youtube.mjs` (`detectOrientation`), `scripts/build-feed.mjs`
- Companion quota rule: discover uploads via the `UU…` uploads playlist
  (channel ID with `UC`→`UU`) at 1 unit per 50, never `search.list` (100 units).
