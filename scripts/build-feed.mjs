#!/usr/bin/env node
// Scheduled build: read config, pull recent uploads from curated channels via the
// YouTube Data API (1-unit calls only), filter for drift, bucket by duration, and
// write public/videos.json. Runnable locally and in CI.
//
//   node scripts/build-feed.mjs [--dry-run] [--verbose] [--fixtures <dir>]
//
// Secrets: reads YOUTUBE_API_KEY from the environment only. Never hardcode.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  validateChannelsConfig,
  validateDenylistConfig,
  validateBlocklistConfig,
  parseIso8601ToSeconds,
} from './lib/filter.mjs';
import {
  createYouTubeClient,
  estimateMaxQuotaUnits,
  QUOTA_CEILING,
} from './lib/youtube.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseArgs(argv) {
  const args = { dryRun: false, verbose: false, fixtures: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--fixtures') args.fixtures = argv[++i];
    else if (a.startsWith('--fixtures=')) args.fixtures = a.slice('--fixtures='.length);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (args.fixtures === undefined) throw new Error('--fixtures requires a directory path');
  return args;
}

async function loadJson(relPath) {
  let raw;
  try {
    raw = await readFile(path.join(ROOT, relPath), 'utf8');
  } catch (e) {
    throw new Error(`${relPath}: cannot read (${e.code || e.message})`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${relPath}: invalid JSON (${e.message})`);
  }
}

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
export async function gatherCandidates(config, { apiKey, fixtures, verbose } = {}) {
  const { channels } = config;
  const labelById = new Map(channels.channels.map((c) => [c.id, c.label]));

  if (fixtures) {
    const raw = await loadJsonAbsolute(path.join(fixtures, 'candidates.json'));
    const candidates = (Array.isArray(raw) ? raw : raw.candidates || []).map((v) =>
      normalizeCandidate(v, labelById)
    );
    if (verbose) console.error(`[fixtures] loaded ${candidates.length} candidate(s) from ${fixtures}`);
    return { candidates, quotaUnits: 0, source: 'fixtures' };
  }

  const estimate = estimateMaxQuotaUnits(channels.channels.length, channels.maxVideosPerChannel);
  if (estimate > QUOTA_CEILING) {
    throw new Error(
      `Estimated quota (${estimate} units) exceeds the safety ceiling (${QUOTA_CEILING}). ` +
        'Reduce channels or maxVideosPerChannel.'
    );
  }

  const client = createYouTubeClient({ apiKey });
  const allIds = [];
  for (const channel of channels.channels) {
    const ids = await client.fetchUploadIds(channel, channels.maxVideosPerChannel);
    if (verbose) console.error(`[fetch] ${channel.label}: ${ids.length} upload(s)`);
    allIds.push(...ids);
  }
  const details = await client.fetchVideoDetails(allIds);
  const candidates = details.map((v) => normalizeCandidate(v, labelById));
  return { candidates, quotaUnits: client.quotaUnits, source: 'api' };
}

async function loadJsonAbsolute(absPath) {
  let raw;
  try {
    raw = await readFile(absPath, 'utf8');
  } catch (e) {
    throw new Error(`${absPath}: cannot read (${e.code || e.message})`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${absPath}: invalid JSON (${e.message})`);
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

  const { candidates, quotaUnits, source } = await gatherCandidates(config, {
    apiKey,
    fixtures: args.fixtures,
    verbose: args.verbose,
  });

  console.log(`Fetched ${candidates.length} candidate video(s) from ${source} (≈${quotaUnits} quota units).`);
  // Filter/bucket/write/report (U5) are wired in the next unit.
}

// Only run when invoked directly (so tests can import the pure exports above).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\nBuild failed: ${err.message}`);
    process.exit(1);
  });
}
