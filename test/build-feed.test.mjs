import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, gatherCandidates, attachScores, applyAutoBlock } from '../scripts/build-feed.mjs';

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
    if (u.hostname === 'www.youtube.com') return { status: 200 }; // /shorts/ probe -> portrait
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
  assert.equal(result.candidates[0].orientation, 'portrait', 'orientation probed on the API path');
  assert.equal(result.channelFailures.length, 1);
  assert.equal(result.channelFailures[0].channel, 'Dead Channel');
});

test('gatherCandidates aborts when every channel fails rather than returning empty', async () => {
  const config = { channels: { channels: [{ id: 'UCzzz', label: 'z' }], maxVideosPerChannel: 5, maxAgeMonths: 12 } };
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  await assert.rejects(() => gatherCandidates(config, { apiKey: 'K', fetchImpl }), /All 1 channel/);
});

test('attachScores bakes vote counts, defaulting missing videos to 0', async () => {
  const videos = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const fetchImpl = async (url) => {
    assert.ok(url.endsWith('/votes'), 'reads the /votes route');
    return { ok: true, json: async () => ({ a: 5, c: 2 }) };
  };
  await attachScores(videos, { endpoint: 'https://votes.example.dev', fetchImpl });
  assert.deepEqual(videos.map((v) => v.score), [5, 0, 2]);
});

test('attachScores leaves scores at 0 when no endpoint is configured', async () => {
  const videos = [{ id: 'a' }];
  let called = false;
  await attachScores(videos, { endpoint: '', fetchImpl: async () => ((called = true), { ok: true, json: async () => ({}) }) });
  assert.equal(videos[0].score, 0);
  assert.equal(called, false, 'no network call without an endpoint');
});

test('applyAutoBlock promotes over-threshold reports into config (dry-run, no write)', async () => {
  const config = { blocklist: { videoIds: ['manual1'], autoBlockThreshold: 2, autoBlocked: [] } };
  const fetchImpl = async (url) => {
    assert.ok(url.endsWith('/reports'), 'reads the /reports route');
    return { ok: true, json: async () => ({ vidA: { count: 2, title: 'Bad A' }, vidB: { count: 1, title: 'B' }, manual1: { count: 9 } }) };
  };
  const changed = await applyAutoBlock(config, { endpoint: 'https://votes.example.dev', dryRun: true, fetchImpl });
  assert.equal(changed, true);
  // vidA crosses threshold and is new; vidB below; manual1 already blocked.
  assert.deepEqual(config.blocklist.autoBlocked.map((a) => a.id), ['vidA']);
  assert.equal(config.blocklist.autoBlocked[0].reports, 2);
  assert.ok(config.blocklist.autoBlocked[0].addedAt, 'stamps addedAt');
});

test('applyAutoBlock is a no-op when the threshold is off (0)', async () => {
  const config = { blocklist: { videoIds: [], autoBlockThreshold: 0, autoBlocked: [] } };
  let called = false;
  const changed = await applyAutoBlock(config, {
    endpoint: 'https://votes.example.dev',
    dryRun: true,
    fetchImpl: async () => ((called = true), { ok: true, json: async () => ({ x: { count: 99 } }) }),
  });
  assert.equal(changed, false);
  assert.equal(called, false, 'no report fetch when disabled');
  assert.deepEqual(config.blocklist.autoBlocked, []);
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
  assert.equal(otter.orientation, 'portrait', 'fixtures may pin orientation');
});
