# squishy 🐾

A tiny, self-maintaining web tool that plays a short, curated feed of wholesome
animal videos from YouTube — a deliberate, joyful alternative to doom-scrolling.
You pick how long you'd like to watch up front; the tool honors that and ends
gently.

- **Zero ongoing curation.** New videos appear automatically as the curated
  channels post them. Routine upkeep is just tuning the channel list and glancing
  at the occasional report — and reported videos can even hide themselves.
- **Gentle by design.** You set an intention up front (2 / 5 / 10 minutes); the
  session ends warmly. No infinite scroll, no "a few more?" nudge. 👍 surfaces
  favorites for everyone; skip and report handle the rest.
- **Free forever.** All API calls happen in a scheduled build, never in the
  browser — so no key is ever exposed and no quota is consumed no matter how many
  people visit.
- **Almost no dependencies.** Vanilla JS front-end, plain Node build (global
  `fetch`, built-in `node:test`), Node 20+. The only server-side piece is an
  optional, tiny Cloudflare Worker for 👍/reports.

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

## Make it your own

Want your own instance — your channels, your vibe? The whole thing is a fork and
a handful of edits. No servers to run, no bill to pay.

1. **Fork this repo** on GitHub.
2. **Get a free YouTube Data API v3 key** and add it as the `YOUTUBE_API_KEY`
   Actions secret. → [Setup](#setup)
3. **Swap in your channels.** Edit `config/channels.json` — replace the starter
   list with the channels you want. → [Maintaining the feed](#maintaining-the-feed)
4. **Turn on GitHub Pages** (Settings → Pages → Source → **GitHub Actions**).
   → [Deploying](#deploying)
5. **Run the feed workflow once** (Actions → *Refresh feed* → *Run workflow*) to
   build `public/videos.json` and publish. From then on it refreshes itself daily.

That's a working site. Everything below is optional polish: 👍/reports need the
[Cloudflare Worker](#-voting--reports-optional); live-cams, the denylist, and
session lengths are all plain-JSON tuning in
[Maintaining the feed](#maintaining-the-feed). Prefer to try it locally first?
`node scripts/build-feed.mjs --dry-run --fixtures fixtures/sample` runs the whole
build offline with no key.

---

## The viewer experience

- **Intention picker** — choose 2, 5, or 10 minutes. Shorter sessions favor
  short clips; longer ones lean into medium/long.
- **Budget-aware playback** — videos auto-advance, and the session ends near your
  chosen length: if the next clip would overshoot the budget by more than
  `max(15%, 60s)`, a shorter one that just barely goes over is played instead.
- **Vertical Shorts** render in a portrait frame instead of being letterboxed
  (detected at build time via a `/shorts/` probe, since the Data API exposes no
  dimensions).
- **👍 / Skip / Report** — like a video (it rises to the top for everyone), skip
  one (only the time you actually watched counts against the budget), or report
  drift.
- **No repeats** — watched videos are remembered in `localStorage` and skipped in
  future sessions until the feed's been seen.
- **Gentle end** — a warm end screen with a single low-key "start over"; no
  guilt, no counters, no "just one more."

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
| `config/blocklist.json` | Hide specific videos. `videoIds` = manual entries. `autoBlockThreshold` = auto-hide a video once it hits this many reports (0 disables). `autoBlocked` = the build-managed list (do not hand-edit except to *un*-hide by deleting an entry). |
| `public/livecams.json` | Optional "Live right now" section — hardcode a few live-stream video IDs. Placeholders (`REPLACE_ME…`) are ignored, so the section stays hidden until you add real IDs. |
| `public/vote-config.json` | The 👍/report Worker URL. Empty = voting/reporting disabled (the buttons fall back gracefully). See **`vote-worker/README.md`**. |

**The starter channels are a suggestion — replace them with your own.** They are
reputable animal channels (aquariums, sanctuaries, and a few beloved cats,
bunnies, and pups) chosen so the tool works out of the box.

### Removing videos

Three ways a video leaves the feed, weakest to strongest:

1. **Manual blocklist** — add its ID to `videoIds` in `config/blocklist.json`. The
   next build drops it. (Grab the ID from any YouTube URL: `youtu.be/<ID>`.)
2. **Report → review** — viewers hit "Report this video"; reports land in the
   Worker's KV. Review them with `curl -s <worker-url>/reports | python3 -m json.tool`,
   then blocklist the ones you want gone.
3. **Auto-blocklist** — when a video reaches `autoBlockThreshold` reports, the
   daily build moves it into `autoBlocked` automatically (durable and auditable in
   git; un-hide by deleting the entry). Requires the Worker (see 👍 Voting below).

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

## 👍 Voting & reports (optional)

A tiny **Cloudflare Worker + KV** adds shared state without giving up the static
design: it collects 👍 votes and reports, and the daily build bakes the results
into the feed. The deployed site only *reads* those results and fires
fire-and-forget POSTs.

- **👍** — viewers like videos; the build bakes a `score` into `videos.json`, and
  the feed orders each session by most-liked (unseen first).
- **Reports** — viewers flag drift; reports land in KV for review, and can
  auto-hide videos at `autoBlockThreshold` (see *Removing videos*).

Setup lives in **`vote-worker/README.md`** (deploy the Worker, then set its URL in
`public/vote-config.json`). Until an endpoint is configured, the 👍 button is
hidden, the report button falls back to a mailto, and ordering is random —
everything else works unchanged.

---

## Repository layout

```
config/          channels.json · denylist.json · blocklist.json          (the editable surface)
scripts/
  build-feed.mjs                    scheduled build: config → API → filter → score/auto-block → videos.json
  lib/filter.mjs · lib/youtube.mjs  pure filter/bucket/auto-block helpers + API wrapper (+ Shorts probe)
public/          index.html · app.js · style.css · videos.json (generated)
  livecams.json · vote-config.json  front-end config
  lib/selection.mjs                 pure session logic (pool, budget-aware pick, seen store)
vote-worker/     worker.js · wrangler.toml · README.md                    optional Cloudflare Worker for 👍/reports
test/            filter · youtube · selection · build-feed                 (node:test)
fixtures/sample/ canned API responses for offline dry-runs
.github/workflows/  refresh-feed.yml (build+commit) · deploy-pages.yml (publish)
```

---

## License

[MIT](LICENSE) — free to use, fork, and build your own version.
