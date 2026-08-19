import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, gatherCandidates } from '../scripts/build-feed.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('parseArgs handles flags, both --fixtures forms, and rejects bad input', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--verbose']), { dryRun: true, verbose: true, fixtures: null, allowEmpty: false });
  assert.equal(parseArgs(['--fixtures', 'dir']).fixtures, 'dir');
  assert.equal(parseArgs(['--fixtures=dir']).fixtures, 'dir');
  assert.equal(parseArgs(['--allow-empty']).allowEmpty, true);
  assert.throws(() => parseArgs(['--bogus']), /Unknown argument/);
  assert.throws(() => parseArgs(['--fixtures']), /requires a directory/);
});

test('gatherCandidates aborts before any fetch when the quota estimate exceeds the ceiling', async () => {
  const channels = Array.from({ length: 50 }, (_, i) => ({ id: `UCquota${i}`, label: `c${i}` }));
  const config = { channels: { channels, maxVideosPerChannel: 1000, maxAgeMonths: 12 } };
  let fetched = false;
  const fetchImpl = async () => {
    fetched = true;
    return { ok: true, json: async () => ({}) };
  };
  await assert.rejects(() => gatherCandidates(config, { apiKey: 'K', fetchImpl }), /safety ceiling/);
  assert.equal(fetched, false, 'must not hit the network past the ceiling');
});

test('gatherCandidates skips a failing channel and keeps the rest', async () => {
  const config = {
    channels: {
      channels: [
        { id: 'UCaaaaaaaaaaaaaaaaaaaaaa', label: 'Dead Channel' },
        { id: 'UCbbbbbbbbbbbbbbbbbbbbbb', label: 'Good Channel' },
      ],
      maxVideosPerChannel: 5,
      maxAgeMonths: 12,
    },
  };
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/playlistItems')) {
      const pl = u.searchParams.get('playlistId');
      if (pl.startsWith('UUaaa')) return { ok: false, status: 404, text: async () => 'not found' };
      return { ok: true, json: async () => ({ items: [{ contentDetails: { videoId: 'good1' } }] }) };
    }
    return {
      ok: true,
      json: async () => ({
        items: [{ id: 'good1', snippet: { title: 't', channelId: 'UCbbbbbbbbbbbbbbbbbbbbbb' }, contentDetails: { duration: 'PT30S' }, status: { privacyStatus: 'public' } }],
      }),
    };
  };
  const result = await gatherCandidates(config, { apiKey: 'K', fetchImpl });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].channelLabel, 'Good Channel');
  assert.equal(result.channelFailures.length, 1);
  assert.equal(result.channelFailures[0].channel, 'Dead Channel');
});

test('gatherCandidates aborts when every channel fails rather than returning empty', async () => {
  const config = { channels: { channels: [{ id: 'UCzzz', label: 'z' }], maxVideosPerChannel: 5, maxAgeMonths: 12 } };
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  await assert.rejects(() => gatherCandidates(config, { apiKey: 'K', fetchImpl }), /All 1 channel/);
});

test('gatherCandidates loads fixtures offline with zero quota', async () => {
  const config = {
    channels: {
      channels: [{ id: 'UCnM5iMGiKsZg-iOlIO2ZkdQ', label: 'Monterey Bay Aquarium' }],
      maxVideosPerChannel: 20,
      maxAgeMonths: 12,
    },
  };
  const result = await gatherCandidates(config, { fixtures: path.join(REPO_ROOT, 'fixtures', 'sample') });
  assert.equal(result.source, 'fixtures');
  assert.equal(result.quotaUnits, 0);
  assert.ok(result.candidates.length > 0);
  const otter = result.candidates.find((c) => c.id === 'otter001');
  assert.equal(otter.channelLabel, 'Monterey Bay Aquarium', 'channelLabel resolves from config by channelId');
});
