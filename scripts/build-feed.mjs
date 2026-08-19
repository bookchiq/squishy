#!/usr/bin/env node
// Scheduled build: read config, pull recent uploads from curated channels via the
// YouTube Data API (1-unit calls only), filter for drift, bucket by duration, and
// write public/videos.json. Runnable locally and in CI.
//
//   node scripts/build-feed.mjs [--dry-run] [--verbose] [--fixtures <dir>]
//
// Secrets: reads YOUTUBE_API_KEY from the environment only. Never hardcode.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  validateChannelsConfig,
  validateDenylistConfig,
  validateBlocklistConfig,
  parseIso8601ToSeconds,
  filterAndBucket,
  dropSummary,
  selectAutoBlocked,
} from './lib/filter.mjs';
import {
  createYouTubeClient,
  estimateMaxQuotaUnits,
  QUOTA_CEILING,
  detectOrientation,
} from './lib/youtube.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseArgs(argv) {
  const args = { dryRun: false, verbose: false, fixtures: null, allowEmpty: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--allow-empty') args.allowEmpty = true;
    else if (a === '--fixtures') args.fixtures = argv[++i];
    else if (a.startsWith('--fixtures=')) args.fixtures = a.slice('--fixtures='.length);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (args.fixtures === undefined) throw new Error('--fixtures requires a directory path');
  return args;
}

// Read + parse a JSON file relative to the repo root.
const loadJson = (relPath) => loadJsonAbsolute(path.join(ROOT, relPath), relPath);

export async function loadConfig() {
  const channels = validateChannelsConfig(await loadJson('config/channels.json'));
  const denylist = validateDenylistConfig(await loadJson('config/denylist.json'));
  const blocklist = validateBlocklistConfig(await loadJson('config/blocklist.json'));
  return { channels, denylist, blocklist };
}

/**
 * Gather raw candidate videos, either from the live API or from an offline
 * fixtures directory (`<dir>/candidates.json`). Returns a uniform candidate
 * shape regardless of source so the filter pipeline is source-agnostic.
 */
export async function gatherCandidates(config, { apiKey, fixtures, verbose, fetchImpl } = {}) {
  const { channels } = config;
  const labelById = new Map(channels.channels.map((c) => [c.id, c.label]));

  if (fixtures) {
    const raw = await loadJsonAbsolute(path.join(fixtures, 'candidates.json'));
    const candidates = (Array.isArray(raw) ? raw : raw.candidates || []).map((v) =>
      normalizeCandidate(v, labelById)
    );
    if (verbose) console.error(`[fixtures] loaded ${candidates.length} candidate(s) from ${fixtures}`);
    return { candidates, quotaUnits: 0, source: 'fixtures', channelFailures: [] };
  }

  const estimate = estimateMaxQuotaUnits(channels.channels.length, channels.maxVideosPerChannel);
  if (estimate > QUOTA_CEILING) {
    throw new Error(
      `Estimated quota (${estimate} units) exceeds the safety ceiling (${QUOTA_CEILING}). ` +
        'Reduce channels or maxVideosPerChannel.'
    );
  }

  const client = createYouTubeClient({ apiKey, ...(fetchImpl ? { fetchImpl } : {}) });
  const allIds = [];
  const channelFailures = [];
  // One dead/renamed/private channel must not fail the whole refresh — skip it and continue.
  for (const channel of channels.channels) {
    try {
      const ids = await client.fetchUploadIds(channel, channels.maxVideosPerChannel);
      if (verbose) console.error(`[fetch] ${channel.label}: ${ids.length} upload(s)`);
      allIds.push(...ids);
    } catch (e) {
      channelFailures.push({ channel: channel.label || channel.id, error: e.message });
      console.error(`[warn] channel "${channel.label || channel.id}" failed, skipping: ${e.message}`);
    }
  }
  if (channelFailures.length === channels.channels.length) {
    throw new Error(`All ${channelFailures.length} channel(s) failed to fetch — aborting rather than writing an empty feed.`);
  }
  const details = await client.fetchVideoDetails(allIds);
  const candidates = details.map((v) => normalizeCandidate(v, labelById));
  // Orientation (portrait/landscape) is a non-API web probe — no quota cost.
  await attachOrientations(candidates, { fetchImpl, verbose });
  return { candidates, quotaUnits: client.quotaUnits, source: 'api', channelFailures };
}

// Probe each candidate's orientation with bounded concurrency; mutate in place.
async function attachOrientations(candidates, { fetchImpl, verbose, concurrency = 8 } = {}) {
  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const c = candidates[cursor++];
      c.orientation = await detectOrientation(c.id, fetchImpl ? { fetchImpl } : {});
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  if (verbose) {
    const portrait = candidates.filter((c) => c.orientation === 'portrait').length;
    console.error(`[orientation] ${portrait} portrait, ${candidates.length - portrait} landscape`);
  }
}

async function resolveVotesEndpoint() {
  if (process.env.VOTES_ENDPOINT) return process.env.VOTES_ENDPOINT.trim();
  try {
    const cfg = await loadJson('public/vote-config.json');
    return String(cfg.endpoint || '').trim();
  } catch {
    return '';
  }
}

/**
 * Bake a 👍 `score` onto each video from the vote worker's /votes tally.
 * No endpoint (or an unreachable one) leaves every score at 0 — the feed still
 * builds; the front-end just orders randomly until votes exist.
 */
export async function attachScores(videos, { fetchImpl, endpoint } = {}) {
  const url = (endpoint !== undefined ? endpoint : await resolveVotesEndpoint()).trim();
  let counts = {};
  if (url) {
    try {
      const res = await (fetchImpl || fetch)(url.replace(/\/$/, '') + '/votes', {
        signal: AbortSignal.timeout(15000),
      });
      if (res && res.ok) counts = await res.json();
    } catch {
      /* votes unavailable — scores stay 0 */
    }
  }
  for (const v of videos) v.score = counts[v.id] || 0;
  return videos;
}

/** Fetch the report tally `{ id: { count, title } }` from the vote worker. */
export async function fetchReports(endpoint, { fetchImpl } = {}) {
  if (!endpoint) return {};
  try {
    const res = await (fetchImpl || fetch)(endpoint.replace(/\/$/, '') + '/reports', {
      signal: AbortSignal.timeout(15000),
    });
    if (res && res.ok) return await res.json();
  } catch {
    /* reports unavailable */
  }
  return {};
}

/**
 * Promote videos that crossed `autoBlockThreshold` reports into the managed
 * `autoBlocked` list on `config.blocklist` (mutated in place). Persists the
 * updated config/blocklist.json unless dryRun. Returns whether anything changed.
 * No-op when the threshold is off (0/absent) or no endpoint is configured.
 */
export async function applyAutoBlock(config, { endpoint, dryRun, fetchImpl } = {}) {
  const bl = config.blocklist;
  const threshold = bl.autoBlockThreshold || 0;
  if (!threshold || threshold < 1 || !endpoint) return false;

  const reports = await fetchReports(endpoint, fetchImpl ? { fetchImpl } : {});
  const already = [...bl.videoIds, ...(bl.autoBlocked || []).map((a) => a.id)];
  const newly = selectAutoBlocked(reports, threshold, already);
  if (newly.length === 0) return false;

  const stamped = newly.map((n) => ({ ...n, addedAt: new Date().toISOString() }));
  bl.autoBlocked = [...(bl.autoBlocked || []), ...stamped];
  for (const n of stamped) {
    console.log(`[auto-block] ${n.id} (${n.reports} report(s)) — ${n.title}`);
  }

  if (!dryRun) {
    await writeFile(path.join(ROOT, 'config', 'blocklist.json'), JSON.stringify(bl, null, 2) + '\n', 'utf8');
    console.log(`Auto-blocked ${stamped.length} video(s); updated config/blocklist.json.`);
  }
  return true;
}

async function loadJsonAbsolute(absPath, displayName = absPath) {
  let raw;
  try {
    raw = await readFile(absPath, 'utf8');
  } catch (e) {
    throw new Error(`${displayName}: cannot read (${e.code || e.message})`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${displayName}: invalid JSON (${e.message})`);
  }
}

function normalizeCandidate(v, labelById) {
  const durationSeconds =
    typeof v.durationSeconds === 'number'
      ? v.durationSeconds
      : v.durationIso
        ? parseIso8601ToSeconds(v.durationIso)
        : null;
  return {
    id: v.id,
    title: v.title ?? '',
    description: v.description ?? '',
    publishedAt: v.publishedAt ?? null,
    durationSeconds,
    privacyStatus: v.privacyStatus ?? null,
    thumbnail: v.thumbnail || (v.id ? `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg` : null),
    channelLabel: labelById.get(v.channelId) || v.channelLabel || v.channelTitle || 'Unknown channel',
    // Fixtures may pin orientation; the API path overrides via attachOrientations.
    orientation: v.orientation === 'portrait' ? 'portrait' : 'landscape',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig();
  const apiKey = process.env.YOUTUBE_API_KEY;

  if (!apiKey && !args.fixtures) {
    throw new Error(
      'YOUTUBE_API_KEY is not set. Provide it via the environment / a local .env, ' +
        'or pass --fixtures <dir> to run offline against canned API responses.'
    );
  }

  if (args.verbose) {
    console.error(
      `[config] ${config.channels.channels.length} channels, ` +
        `${config.denylist.keywords.length} denylist keywords, ` +
        `${config.blocklist.videoIds.length} blocklisted IDs.`
    );
  }

  const { candidates, quotaUnits, source, channelFailures } = await gatherCandidates(config, {
    apiKey,
    fixtures: args.fixtures,
    verbose: args.verbose,
  });

  const endpoint = await resolveVotesEndpoint();

  // Auto-blocklist: promote videos that crossed the report threshold into the
  // managed autoBlocked list (persisted so they stay hidden and stay auditable).
  await applyAutoBlock(config, { endpoint, dryRun: args.dryRun });

  const blockedIds = [...config.blocklist.videoIds, ...(config.blocklist.autoBlocked || []).map((a) => a.id)];

  const { videos, drops } = filterAndBucket(candidates, {
    blocklist: blockedIds,
    keywords: config.denylist.keywords,
    maxAgeMonths: config.channels.maxAgeMonths,
  });

  if (args.verbose) {
    for (const d of drops) {
      console.error(`[drop] ${d.id}: ${d.reason}${d.detail ? ` (${d.detail})` : ''}`);
    }
  }

  // Bake 👍 scores from the vote worker (0 for everything if not configured).
  await attachScores(videos, { endpoint });

  // Freshest first (the front-end re-orders by score at play time).
  videos.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));

  const output = {
    generatedAt: new Date().toISOString(),
    videos,
  };

  const buckets = { short: 0, medium: 0, long: 0 };
  for (const v of videos) buckets[v.bucket] += 1;

  printReport({ source, quotaUnits, inCount: candidates.length, videos, drops, buckets, dryRun: args.dryRun });
  if (channelFailures && channelFailures.length) {
    console.log(`channels skipped (fetch failed): ${channelFailures.length}`);
  }

  if (args.dryRun) {
    console.log('\n[dry-run] Nothing written. Re-run without --dry-run to write public/videos.json.');
    return;
  }

  // Floor guard: never overwrite a healthy feed with an empty one (a collapsed
  // denylist, mass aging-out, etc. would otherwise ship an empty site silently).
  if (videos.length === 0 && !args.allowEmpty) {
    throw new Error(
      'Kept 0 videos — refusing to overwrite public/videos.json with an empty feed. ' +
        'Check the report above (over-broad denylist? all channels failed?). Pass --allow-empty to override.'
    );
  }

  const outPath = path.join(ROOT, 'public', 'videos.json');
  await writeFile(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(`\nWrote ${videos.length} video(s) to public/videos.json`);
}

function printReport({ source, quotaUnits, inCount, videos, drops, buckets, dryRun }) {
  const summary = dropSummary(drops);
  const lines = [];
  lines.push('');
  lines.push(`── Build report${dryRun ? ' (dry-run)' : ''} ──`);
  lines.push(`source: ${source}   estimated quota: ≈${quotaUnits} unit(s)`);
  lines.push(`in: ${inCount}   kept: ${videos.length}   dropped: ${drops.length}`);
  lines.push(`buckets: short=${buckets.short} medium=${buckets.medium} long=${buckets.long}`);
  if (drops.length) {
    lines.push('dropped by reason:');
    for (const [reason, count] of Object.entries(summary).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${reason}: ${count}`);
    }
  }
  console.log(lines.join('\n'));
}

// Only run when invoked directly (so tests can import the pure exports above).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\nBuild failed: ${err.message}`);
    process.exit(1);
  });
}
