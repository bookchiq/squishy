import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  uploadsPlaylistId,
  chunk,
  estimateMaxQuotaUnits,
  redactKey,
  buildPlaylistItemsUrl,
  buildVideosUrl,
  createYouTubeClient,
} from '../scripts/lib/youtube.mjs';

test('uploadsPlaylistId swaps only the UC prefix for UU', () => {
  assert.equal(uploadsPlaylistId('UCnM5iMGiKsZg-iOlIO2ZkdQ'), 'UUnM5iMGiKsZg-iOlIO2ZkdQ');
  assert.throws(() => uploadsPlaylistId('XYZ123'), /channel ID/);
  assert.throws(() => uploadsPlaylistId(null), /channel ID/);
});

test('chunk batches ids into groups of at most 50', () => {
  assert.equal(chunk(Array.from({ length: 130 }, (_, i) => i)).length, 3);
  assert.deepEqual(chunk(Array.from({ length: 130 }, (_, i) => i)).map((b) => b.length), [50, 50, 30]);
  assert.equal(chunk([]).length, 0);
  assert.equal(chunk(Array.from({ length: 50 }, (_, i) => i)).length, 1);
});

test('estimateMaxQuotaUnits accounts for playlist paging and detail batches', () => {
  // 3 channels, 20 each: 3 playlist pages + ceil(60/50)=2 detail calls = 5.
  assert.equal(estimateMaxQuotaUnits(3, 20), 5);
  // 1 channel, 120 uploads: ceil(120/50)=3 pages + ceil(120/50)=3 details = 6.
  assert.equal(estimateMaxQuotaUnits(1, 120), 6);
});

test('redactKey strips the key value from a URL', () => {
  const url = 'https://x/videos?part=snippet&key=SECRET123&id=abc';
  assert.equal(redactKey(url), 'https://x/videos?part=snippet&key=REDACTED&id=abc');
  assert.ok(!redactKey(url).includes('SECRET123'));
});

test('request builders never emit a search endpoint and fetch the required parts', () => {
  const p = buildPlaylistItemsUrl('UUabc', 'K', undefined);
  const v = buildVideosUrl(['a', 'b'], 'K');
  assert.ok(p.includes('/playlistItems'));
  assert.ok(v.includes('/videos'));
  assert.ok(!p.includes('/search'));
  assert.ok(!v.includes('/search'));
  assert.ok(v.includes('part=contentDetails%2Csnippet%2Cstatus'), 'videos.list must request status for the non-public drop');
});

test('client counts one quota unit per list call', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    if (url.includes('/playlistItems')) {
      return { ok: true, json: async () => ({ items: [{ contentDetails: { videoId: 'v1' } }] }) };
    }
    return { ok: true, json: async () => ({ items: [{ id: 'v1', snippet: {}, contentDetails: { duration: 'PT30S' }, status: { privacyStatus: 'public' } }] }) };
  };
  const client = createYouTubeClient({ apiKey: 'K', fetchImpl });
  const ids = await client.fetchUploadIds({ id: 'UCabc' }, 20);
  await client.fetchVideoDetails(ids);
  assert.equal(client.quotaUnits, 2, 'one playlistItems call + one videos call');
  assert.equal(calls, 2);
});

test('an API error surfaces as a loud failure with the key redacted', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => 'quota exceeded key=SECRET' });
  const client = createYouTubeClient({ apiKey: 'SECRET', fetchImpl });
  await assert.rejects(
    () => client.fetchVideoDetails(['a']),
    (err) => {
      assert.ok(/403/.test(err.message));
      assert.ok(!err.message.includes('SECRET'), 'key must be redacted from surfaced errors');
      return true;
    }
  );
});
