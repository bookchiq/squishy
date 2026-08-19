# squishy 🐾

A tiny, self-maintaining web tool that plays a short, curated feed of wholesome
animal videos from YouTube — a deliberate, joyful alternative to doom-scrolling.
You pick how long you'd like to watch up front; the tool honors that and ends
gently.

- **Zero ongoing curation.** New videos appear automatically as the curated
  channels post them. The only routine edits are a short channel list and a small
  blocklist.
- **Free forever.** All API calls happen in a scheduled build, never in the
  browser — so no key is ever exposed and no quota is consumed no matter how many
  people visit.
- **No dependencies.** Vanilla JS front-end, plain Node build (global `fetch`,
  built-in `node:test`). Node 20+.

---

## How it works

Two clean halves joined by a static JSON file:

```
config/*.json ──► scripts/build-feed.mjs (scheduled) ──► public/videos.json ──► static front-end
                     (calls the YouTube API)                                     (no API calls)
```

A GitHub Action runs the build on a schedule, filters for drift, buckets videos
by duration, and commits `public/videos.json` back to the repo. The front-end is
fully static: it fetches `videos.json` and plays via the YouTube IFrame Player
API. All secrets, API cost, and filtering live in the build; the deployed site is
dumb, static, and safe.

---

## ⚠️ Guardrail caveat (please read)

Drift defense is **allowlist (curated channels) + denylist (keywords) + blocklist
(manual) + age/duration bounds**. This is metadata pattern-matching, **not**
content understanding. A cheerful title on a sad video can still get through. This
is a deliberate v1 tradeoff: the goal is to make drift *rare and quickly fixable*,
not impossible. True screening (a vision/LLM pass on thumbnails or transcripts) is
out of scope for v1.

---

## Setup

### 1. Get a YouTube Data API v3 key

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create
   (or pick) a project.
2. **APIs & Services → Library →** enable **YouTube Data API v3**.
3. **APIs & Services → Credentials → Create credentials → API key.** Copy it.
   (No billing/credit card is required for the free 10,000 units/day.)

### 2. Store the key

- **For CI:** in your GitHub repo, **Settings → Secrets and variables → Actions →
  New repository secret**, named `YOUTUBE_API_KEY`.
- **For local dev:** copy `.env.example` to `.env` and paste the key:
  ```
  YOUTUBE_API_KEY=your-key-here
  ```
  `.env` is gitignored — never commit it.

### 3. Run the build locally

```bash
# Dry run against the live API (needs a key) — writes nothing, prints the report:
npm run dry-run

# Offline dry run against sample fixtures — no key needed:
node scripts/build-feed.mjs --dry-run --fixtures fixtures/sample

# Real build — writes public/videos.json:
npm run build

# Tests:
npm test
```

`npm run build` / `npm run dry-run` load `.env` automatically via Node's native
`--env-file-if-exists`. In CI the key comes from the Actions secret instead.

**Flags:** `--dry-run` (write nothing, print the full drop report), `--verbose`
(per-video decisions + fetch/drop detail to STDERR), `--fixtures <dir>` (run
offline against canned responses in `<dir>/candidates.json`).

---

## Maintaining the feed

Everything a human or an agent needs to tune lives in plain JSON — no code changes.

| File | What it does |
|------|--------------|
| `config/channels.json` | The channels to pull uploads from. Add/remove `{ "id": "UC…", "label": "…", "trust": "high" }`. Find a channel ID at `youtube.com/channel/<id>` or via Social Blade. Tune `maxVideosPerChannel` and `maxAgeMonths`. |
| `config/denylist.json` | Case-insensitive keyword substrings matched against title+description. Keep it **conservative** — over-filtering silently shrinks the feed. Every drop is logged (`--dry-run`) so tuning is evidence-based. |
| `config/blocklist.json` | Hide a specific video that slipped through — add its ID to `videoIds`. Rare. |
| `public/livecams.json` | Optional "Live right now" section — hardcode a few live-stream video IDs. Placeholders (`REPLACE_ME…`) are ignored, so the section stays hidden until you add real IDs. |

**The starter channels are a suggestion — replace them with your own.** They are
reputable aquarium/zoo channels chosen so the tool works out of the box.

### Blocking a reported video

The front-end's "Report this video" link opens a prefilled email to the maintainer
(edit `MAINTAINER_EMAIL` at the top of `public/app.js`). To act on a report, add
the video ID to `config/blocklist.json`.

---

## Deploying

`public/` is a fully static site — serve it with **any** static host (GitHub
Pages, Netlify, Cloudflare Pages) with no build step of its own, because
`public/videos.json` is committed to the repo.

**GitHub Pages (default): use the GitHub Actions source, not "deploy from a
branch".** Pages' deploy-from-a-branch mode can only serve `/` or `/docs`, never
an arbitrary `public/` folder. This repo therefore ships a Pages **Actions**
workflow (`.github/workflows/deploy-pages.yml`) that publishes the `public/`
directory as the Pages artifact.

To enable it: **Settings → Pages → Build and deployment → Source → GitHub
Actions**. The site then deploys on every push to `main`, and — via a
`workflow_run` trigger — after each scheduled feed refresh. That chaining is
what solves the classic gotcha: the refresh workflow's `GITHUB_TOKEN` commit of
`videos.json` would **not** trigger an ordinary `on: push` deploy, so the deploy
workflow listens for the refresh workflow completing instead.

- `refresh-feed.yml` needs `contents: write` (declared) to commit the feed; the
  default `GITHUB_TOKEN` is sufficient — no personal access token required.
- `deploy-pages.yml` needs `pages: write` + `id-token: write` (declared).

**Other hosts (Netlify / Cloudflare Pages):** set the publish directory to
`public/` and no build command. The committed `videos.json` means there is
nothing to build.

---

## 👍 Voting (optional)

Viewers can 👍 videos they love; the feed then orders each session by most-liked
(unseen first). It stays true to the static design: a tiny **Cloudflare Worker +
KV** collects votes, and the daily build bakes a `score` into `videos.json` — the
deployed site only reads that score and fires a like POST.

Setup lives in **`vote-worker/README.md`** (deploy the Worker, then set the URL in
`public/vote-config.json`). Until an endpoint is configured, the 👍 button is
hidden and ordering falls back to random — everything else works unchanged.

---

## Repository layout

```
config/          channels.json · denylist.json · blocklist.json   (the editable surface)
scripts/
  build-feed.mjs                 scheduled build entrypoint (CLI, I/O, API)
  lib/filter.mjs · lib/youtube.mjs   pure filter/bucket helpers + API wrapper
public/          index.html · app.js · style.css · videos.json (generated) · livecams.json
  lib/selection.mjs              pure session-selection logic
test/            filter · youtube · selection  (node:test)
fixtures/sample/ canned API responses for offline dry-runs
.github/workflows/refresh-feed.yml
```

---

## License

MIT.
