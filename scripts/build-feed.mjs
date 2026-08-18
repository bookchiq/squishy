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
} from './lib/filter.mjs';

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

  console.log(
    `Config OK: ${config.channels.channels.length} channels, ` +
      `${config.denylist.keywords.length} denylist keywords, ` +
      `${config.blocklist.videoIds.length} blocklisted IDs.`
  );
  // Fetch (U4) and filter/bucket/write/report (U5) are wired in the next units.
}

// Only run when invoked directly (so tests can import the pure exports above).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\nBuild failed: ${err.message}`);
    process.exit(1);
  });
}
