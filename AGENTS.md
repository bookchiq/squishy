# squishy — Agent Instructions

Primary, agent-agnostic instructions for working in this repo. Read this before
making changes.

## Overview

squishy is a tiny, self-maintaining web tool that plays a short, curated feed of
wholesome animal videos from YouTube — a deliberate, gentle alternative to
doom-scrolling. A viewer sets an intention (2 / 5 / 10 minutes); the session
honors it and ends warmly. See `README.md` for user/operator docs and
`docs/refs/SPEC.md` for the original build spec.

## Architecture

Two halves joined by a static `public/videos.json`, plus an optional edge worker:

- **Scheduled build** (`scripts/`, Node, ESM): reads `config/*.json`, pulls recent
  uploads from curated channels via the YouTube Data API using only 1-unit calls
  (uploads playlist `UC`→`UU`; **never** `search.list`), filters for drift,
  buckets by duration, detects orientation, bakes 👍 scores / auto-blocklist, and
  writes `public/videos.json`. A GitHub Action runs it on a schedule and commits
  the result back.
- **Static front-end** (`public/`, vanilla JS): fetches `videos.json` and plays via
  the YouTube IFrame Player API. **Makes no Data API calls** — no key, no quota,
  regardless of traffic. All secrets, cost, and filtering live in the build.
- **Vote worker** (`vote-worker/`, optional): a tiny Cloudflare Worker + KV that
  collects 👍 votes and reports; the daily build bakes the tallies into the feed.

## Repo map

```
config/          channels.json · denylist.json · blocklist.json      (editable JSON surface)
scripts/         build-feed.mjs · lib/{filter,youtube}.mjs           scheduled build + pure helpers
public/          index.html · app.js · style.css · videos.json(gen)  static site
                 livecams.json · vote-config.json · lib/selection.mjs
vote-worker/     worker.js · wrangler.toml · README.md               optional 👍/report worker
test/            *.test.mjs                                          node:test
fixtures/sample/ canned API responses for offline dry-runs
docs/            refs/SPEC.md · plans/ · solutions/                  spec, plans, learnings
.github/workflows/  refresh-feed.yml (build+commit) · deploy-pages.yml (publish)
```

## Development

- **Runtime:** Node 20+. **No runtime dependencies** (global `fetch`, built-in
  `node:test`). Keep it that way — prefer platform APIs over adding a package.
- **Test:** `npm test` (node:test). Add/adjust tests for behavior changes.
- **Build:** `npm run build` (writes `public/videos.json`; loads `.env` if present).
- **Dry run:** `npm run dry-run`, or offline with no key:
  `node scripts/build-feed.mjs --dry-run --fixtures fixtures/sample`.
- **Pure logic is factored out** into `scripts/lib/filter.mjs`,
  `scripts/lib/youtube.mjs`, and `public/lib/selection.mjs` specifically so it's
  unit-testable without the network or a browser. Put new logic there and test it;
  keep DOM/IFrame and I/O in the thin `app.js` / `build-feed.mjs` shells.

## Documented learnings

`docs/solutions/` — a searchable store of durable learnings from this project
(knowledge and gotchas), organized by category with YAML frontmatter (`module`,
`tags`, `problem_type`). Relevant when working on the build pipeline, deployment,
YouTube integration, or the vote worker — a few non-obvious things (GitHub Pages
deploy behavior, YouTube Shorts detection, static-site shared state) are captured
there. Grep it before re-deriving.

## Config surface (no code changes needed)

- `config/channels.json` — curated channels (`{id, label, trust}`) + `maxVideosPerChannel` / `maxAgeMonths`.
- `config/denylist.json` — word-boundary keyword filters on title+description. Keep conservative.
- `config/blocklist.json` — `videoIds` (manual), `autoBlockThreshold`, and the build-managed `autoBlocked` list.
- `public/livecams.json` — optional live-cam embeds.
- `public/vote-config.json` — the vote worker URL (empty = voting/reporting off).

## Deploy

GitHub Pages via **GitHub Actions source** (not deploy-from-branch, which can't
serve `public/`). The refresh Action commits the feed; a `workflow_run`-chained
deploy publishes it. See
`docs/solutions/tooling-decisions/github-pages-subfolder-and-workflow-run-chaining.md`
for the why. Worker deploy: `vote-worker/README.md`.

## Conventions & ethos

- **Git:** work on feature branches, open a PR, never commit directly to `main`.
  Conventional commit messages (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`).
- **Quality:** tests pass before shipping; behavior changes get tests.
- **Design ethos — this is the point of the project.** squishy is an *antidote* to
  the algorithmic feed, so it must never adopt its dark patterns: no infinite
  scroll, no autoplay-forever, no "just one more" nudges, no shaming counters, no
  guilt. Warm, calm, honest copy. The intention set up front is the only nudge.
- **Honesty over polish.** Drift defense is metadata-only (curated channels +
  keyword/blocklist + bounds), *not* content understanding — say so plainly rather
  than implying the feed is perfectly vetted. What's curated is the **channel
  list**, not each video.
