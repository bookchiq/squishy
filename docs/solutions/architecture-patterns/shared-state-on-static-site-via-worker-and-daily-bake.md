---
title: Shared state on a static site via a tiny Worker + a daily bake
date: 2026-08-19
category: architecture-patterns
module: shared-state
problem_type: architecture_pattern
component: infrastructure
severity: medium
applies_when:
  - "Adding shared/collaborative state (votes, reports, counts) to a static site"
  - "You want to avoid standing up a runtime backend or database"
  - "Periodic (e.g. daily) freshness of the shared data is acceptable"
tags: [static-site, cloudflare-worker, workers-kv, shared-state, jamstack, edge]
---

# Shared state on a static site via a tiny Worker + a daily bake

## Context

squishy is a fully static site (GitHub Pages) with all real work in a scheduled
build. Adding 👍 votes and reports needed *shared, writable* state — the one thing
a static site can't do alone. The goal was to add it without giving up the static
architecture (no runtime server, no exposed secrets, free at small scale).

## Guidance

Split the write path from the read path, and let the existing build be the bridge:

1. **A tiny edge function collects writes.** A Cloudflare Worker + KV namespace
   with two routes — `POST /vote` (increment a counter) and `GET /votes` (read the
   tally) — CORS-restricted to the site origin. That's the entire "backend."
2. **The scheduled build bakes the tally into the committed data file.** The daily
   job that already regenerates `videos.json` also does `GET /votes` and writes a
   `score` onto each item.
3. **The deployed front-end only reads the baked file** and fires *fire-and-forget*
   POSTs for new votes. It never reads live shared state at render time.

```
browser ──POST──▶ Worker+KV ──GET (once/day)──▶ scheduled build ──bake──▶ videos.json (committed)
   ▲                                                                            │
   └───────────────────── reads baked score/order ◀────── static site ◀────────┘
```

The deployed site stays 100% static; the only new infrastructure is one function
+ one KV namespace, free at friend-scale.

## Why This Matters

It preserves everything good about a static host (cheap, safe, no server to
operate, no key in the browser) while still supporting collective features. The
same Worker later absorbed a `POST /report` route and the build grew an
auto-blocklist step — the pattern extended cleanly because the seam (write → KV →
daily bake → committed file) was already there.

## When to Apply

- Any static/JAMstack site that needs a *little* shared state and can tolerate the
  shared data lagging by the build cadence.
- **Not** when you need real-time shared state (use a live backend/websocket then).

## Examples

- KV `list()` is **eventually consistent (~60s lag)** behind a write — irrelevant
  for a once-a-day bake, but don't expect a just-written key to appear in a
  `GET /votes` immediately. `getWithMetadata` on a specific key is strongly
  consistent; storing the count in KV metadata lets `list()` return counts
  without an extra read per key.
- Counters use read-modify-write, so concurrent writes to the *same* key can
  rarely lose one — fine for a friendly audience, not for precise accounting.
- Keep the front-end POST fire-and-forget with a local optimistic update, so a
  network hiccup never blocks the UI; the daily bake reconciles the truth.

## Related

- `vote-worker/worker.js`, `scripts/build-feed.mjs` (`attachScores`, `applyAutoBlock`)
- Companion doc: serving/redeploying the static site itself —
  [../tooling-decisions/github-pages-subfolder-and-workflow-run-chaining.md](../tooling-decisions/github-pages-subfolder-and-workflow-run-chaining.md).
