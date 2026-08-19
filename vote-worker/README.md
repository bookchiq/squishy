# squishy vote worker

A tiny Cloudflare Worker + KV that records 👍 votes for the squishy feed. The
static site POSTs a vote here; the daily build reads the tallies and bakes a
`score` into `public/videos.json`, which the front-end uses to order videos
(most-liked, unseen-first). The deployed site stays fully static.

## Deploy (one-time)

Requires a free Cloudflare account and the Wrangler CLI (`npm i -g wrangler`).

```bash
cd vote-worker
wrangler login                          # opens the browser to authorize
wrangler kv namespace create VOTES      # prints an id — paste it into wrangler.toml
# edit wrangler.toml: set kv_namespaces.id, and ALLOWED_ORIGIN to your site origin
wrangler deploy                         # prints the Worker URL, e.g. https://squishy-votes.<subdomain>.workers.dev
```

Then wire the URL into the app:

1. Put the Worker URL in `public/vote-config.json` -> `"endpoint"`.
2. Add it to the build so scores get baked: set a repo **variable** `VOTES_ENDPOINT`
   to the same URL (Settings -> Secrets and variables -> Actions -> Variables), or
   rely on `public/vote-config.json` (the build reads that file as a fallback).

## Routes

- `POST /vote` with `{ "videoId": "abc123" }` -> `{ "videoId": "abc123", "count": 5 }`
- `GET /votes` -> `{ "abc123": 5, ... }`

## Notes

- CORS is restricted to `ALLOWED_ORIGIN`.
- Counts are best-effort (read-modify-write); fine for a small audience.
- Free tier is ample: KV allows ~100k reads/day and 1k writes/day.
