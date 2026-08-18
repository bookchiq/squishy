import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseIso8601ToSeconds,
  bucketFor,
  matchesDenylist,
  isTooOld,
  exceedsDurationCap,
  validateChannelsConfig,
  validateDenylistConfig,
  validateBlocklistConfig,
} from '../scripts/lib/filter.mjs';

test('parseIso8601ToSeconds parses hours/minutes/seconds', () => {
  assert.equal(parseIso8601ToSeconds('PT47S'), 47);
  assert.equal(parseIso8601ToSeconds('PT1M3S'), 63);
  assert.equal(parseIso8601ToSeconds('PT1H2M'), 3720);
  assert.equal(parseIso8601ToSeconds('P1DT2H'), 93600);
});

test('parseIso8601ToSeconds returns null for malformed / empty durations', () => {
  assert.equal(parseIso8601ToSeconds('abc'), null);
  assert.equal(parseIso8601ToSeconds('PT'), null);
  assert.equal(parseIso8601ToSeconds(''), null);
  assert.equal(parseIso8601ToSeconds(null), null);
  assert.equal(parseIso8601ToSeconds(42), null);
});

test('bucketFor tags durations at the documented boundaries', () => {
  assert.equal(bucketFor(47), 'short');
  assert.equal(bucketFor(59), 'short');
  assert.equal(bucketFor(60), 'medium');
  assert.equal(bucketFor(240), 'medium');
  assert.equal(bucketFor(241), 'long');
  assert.equal(bucketFor(1200), 'long');
});

test('matchesDenylist is case-insensitive substring on title+description', () => {
  const kw = ['rip ', 'urgent', 'gofundme'];
  assert.ok(matchesDenylist('RIP Buddy', '', kw), 'RIP Buddy should match "rip "');
  assert.ok(!matchesDenylist('Scripture study', '', kw), '"scripture" should NOT match "rip "');
  assert.ok(matchesDenylist('URGENT: help', '', kw));
  assert.ok(matchesDenylist('Cute otter', 'link to gofundme here', kw), 'description matches too');
  assert.equal(matchesDenylist('Otter eats a clam', 'wholesome', kw), null);
});

test('isTooOld drops videos older than the cap, keeps fresh ones', () => {
  const now = new Date('2026-08-18T00:00:00Z');
  const thirteenMonthsAgo = '2025-07-01T00:00:00Z';
  const elevenMonthsAgo = '2025-09-18T00:00:00Z';
  assert.equal(isTooOld(thirteenMonthsAgo, 12, now), true);
  assert.equal(isTooOld(elevenMonthsAgo, 12, now), false);
  assert.equal(isTooOld('not-a-date', 12, now), false, 'unparseable date is kept, not dropped');
});

test('exceedsDurationCap respects the boundary', () => {
  assert.equal(exceedsDurationCap(1201, 1200), true);
  assert.equal(exceedsDurationCap(1200, 1200), false);
});

test('validateChannelsConfig rejects bad shapes with a file-named message', () => {
  assert.throws(() => validateChannelsConfig({ channels: [{ label: 'x' }], maxVideosPerChannel: 20, maxAgeMonths: 12 }), /channels\[0\]\.id/);
  assert.throws(() => validateChannelsConfig({ channels: [{ id: 'XYZ123' }], maxVideosPerChannel: 20, maxAgeMonths: 12 }), /starting with "UC"/);
  assert.throws(() => validateChannelsConfig({ channels: [], maxVideosPerChannel: 20, maxAgeMonths: 12 }), /empty/);
  assert.throws(() => validateChannelsConfig({ channels: [{ id: 'UCabc' }], maxVideosPerChannel: 0, maxAgeMonths: 12 }), /maxVideosPerChannel/);
  assert.doesNotThrow(() => validateChannelsConfig({ channels: [{ id: 'UCabc', label: 'ok' }], maxVideosPerChannel: 20, maxAgeMonths: 12 }));
});

test('validateDenylistConfig and validateBlocklistConfig require their arrays', () => {
  assert.throws(() => validateDenylistConfig({}), /keywords/);
  assert.throws(() => validateBlocklistConfig({}), /videoIds/);
  assert.doesNotThrow(() => validateDenylistConfig({ keywords: [] }));
  assert.doesNotThrow(() => validateBlocklistConfig({ videoIds: [] }));
});
