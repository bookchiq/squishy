// Thin YouTube Data API v3 wrapper. Discovery is by channel uploads only — we
// NEVER call search.list (100 units). Every call here costs 1 unit.
//
// The request-shaping helpers are pure and unit-tested; the client wraps global
// fetch (Node 20+) so no HTTP dependency is needed.

import { parseIso8601ToSeconds } from './filter.mjs';

const API = 'https://www.googleapis.com/youtube/v3';

/** Hard ceiling on estimated quota units per run — a runaway-channel-list backstop. */
export const QUOTA_CEILING = 500;

/** Per-request timeout (ms) so a half-open connection fails loudly instead of hanging. */
export const FETCH_TIMEOUT_MS = 15000;

/** Every channel's uploads playlist ID is its channel ID with the leading UC swapped for UU. */
export function uploadsPlaylistId(channelId) {
  if (typeof channelId !== 'string' || !/^UC/.test(channelId)) {
    throw new Error(`Not a channel ID (expected UC…): ${channelId}`);
  }
  return 'UU' + channelId.slice(2);
}

/** Split ids into chunks of at most `size` (default 50, the videos.list batch limit). */
export function chunk(ids, size = 50) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** Estimate the worst-case quota units a run would consume (for the runaway guard). */
export function estimateMaxQuotaUnits(channelCount, maxVideosPerChannel) {
  const pagesPerChannel = Math.max(1, Math.ceil(maxVideosPerChannel / 50));
  const playlistCalls = channelCount * pagesPerChannel;
  const detailCalls = Math.ceil((channelCount * maxVideosPerChannel) / 50);
  return playlistCalls + detailCalls;
}

/** Replace the API key value in a URL so it never lands in logs. */
export function redactKey(url) {
  return String(url).replace(/([?&]key=)[^&]+/g, '$1REDACTED');
}

export function buildPlaylistItemsUrl(playlistId, apiKey, pageToken) {
  const u = new URL(`${API}/playlistItems`);
  u.searchParams.set('part', 'contentDetails');
  u.searchParams.set('maxResults', '50');
  u.searchParams.set('playlistId', playlistId);
  u.searchParams.set('key', apiKey);
  if (pageToken) u.searchParams.set('pageToken', pageToken);
  return u.toString();
}

export function buildVideosUrl(ids, apiKey) {
  const u = new URL(`${API}/videos`);
  u.searchParams.set('part', 'contentDetails,snippet,status');
  u.searchParams.set('id', ids.join(','));
  u.searchParams.set('key', apiKey);
  return u.toString();
}

function pickThumbnail(thumbnails, videoId) {
  return (
    thumbnails?.high?.url ||
    thumbnails?.medium?.url ||
    thumbnails?.default?.url ||
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
  );
}

/**
 * Create a live API client backed by `fetchImpl` (defaults to global fetch).
 * Tracks quota units consumed (1 per list call).
 */
export function createYouTubeClient({ apiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('createYouTubeClient: apiKey is required');
  const state = { quotaUnits: 0 };

  // Strip both the key= URL param and any literal occurrence of the key value.
  const scrub = (text) => redactKey(text).split(apiKey).join('REDACTED');

  async function getJson(url) {
    state.quotaUnits += 1;
    let res;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (e) {
      // Network error / timeout — surface loudly, key scrubbed, never a silent empty feed.
      throw new Error(`YouTube API request failed for ${scrub(url)} — ${scrub(e.message || String(e))}`);
    }
    if (!res.ok) {
      let body = '';
      try {
        body = await res.text();
      } catch {
        /* ignore */
      }
      throw new Error(`YouTube API ${res.status} for ${scrub(url)} — ${scrub(body).slice(0, 300)}`);
    }
    return res.json();
  }

  async function fetchUploadIds(channel, maxVideos) {
    const playlistId = uploadsPlaylistId(channel.id);
    const ids = [];
    let pageToken;
    do {
      const data = await getJson(buildPlaylistItemsUrl(playlistId, apiKey, pageToken));
      for (const item of data.items || []) {
        const vid = item.contentDetails?.videoId;
        if (vid) ids.push(vid);
        if (ids.length >= maxVideos) break;
      }
      pageToken = ids.length >= maxVideos ? undefined : data.nextPageToken;
    } while (pageToken);
    return ids.slice(0, maxVideos);
  }

  async function fetchVideoDetails(ids) {
    const out = [];
    for (const batch of chunk(ids, 50)) {
      if (batch.length === 0) continue;
      const data = await getJson(buildVideosUrl(batch, apiKey));
      for (const item of data.items || []) {
        out.push({
          id: item.id,
          title: item.snippet?.title ?? '',
          description: item.snippet?.description ?? '',
          publishedAt: item.snippet?.publishedAt ?? null,
          channelId: item.snippet?.channelId ?? null,
          channelTitle: item.snippet?.channelTitle ?? '',
          durationSeconds: parseIso8601ToSeconds(item.contentDetails?.duration),
          privacyStatus: item.status?.privacyStatus ?? null,
          thumbnail: pickThumbnail(item.snippet?.thumbnails, item.id),
        });
      }
    }
    return out;
  }

  return {
    fetchUploadIds,
    fetchVideoDetails,
    get quotaUnits() {
      return state.quotaUnits;
    },
  };
}
