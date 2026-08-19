// Pure, I/O-free helpers for the build pipeline. No network, no filesystem, no
// process access — so they are cheap to unit-test and safe to import anywhere.

/** Duration bucket boundaries (seconds). */
export const BUCKET_SHORT_MAX = 60; // < 60s  => short
export const BUCKET_MEDIUM_MAX = 240; // 60s–4min => medium; > 4min => long
/** Hard duration cap — anything longer is likely a livestream replay or vlog, not a clip. */
export const DURATION_CAP_SECONDS = 20 * 60;

/**
 * Parse an ISO-8601 duration (YouTube `contentDetails.duration`, e.g. "PT1M3S")
 * into whole seconds. Returns null for malformed input or an empty duration.
 */
export function parseIso8601ToSeconds(iso) {
  if (typeof iso !== 'string') return null;
  const m = iso.match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const [, w, d, h, min, s] = m;
  if ([w, d, h, min, s].every((x) => x === undefined)) return null; // "P", "PT" — no components
  return (
    Number(w || 0) * 604800 +
    Number(d || 0) * 86400 +
    Number(h || 0) * 3600 +
    Number(min || 0) * 60 +
    Number(s || 0)
  );
}

/** Tag a duration (seconds) as short / medium / long. Does not enforce the cap. */
export function bucketFor(seconds) {
  if (seconds < BUCKET_SHORT_MAX) return 'short';
  if (seconds <= BUCKET_MEDIUM_MAX) return 'medium';
  return 'long';
}

function keywordRegex(keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Word-boundary match so "died" does not match "studied" and "rip" not "trip".
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

/**
 * Word-boundary match of any denylist keyword against title+description.
 * Blank/whitespace keywords are skipped (they would otherwise match everything).
 * Returns the matched keyword (truthy) or null (no match) so callers can log the reason.
 */
export function matchesDenylist(title, description, keywords) {
  const hay = `${title || ''} ${description || ''}`;
  for (const k of keywords) {
    const trimmed = String(k).trim();
    if (!trimmed) continue;
    if (keywordRegex(trimmed).test(hay)) return k;
  }
  return null;
}

/** True when `publishedAt` is older than `maxAgeMonths` before `now`. Unparseable dates are kept (not dropped). */
export function isTooOld(publishedAt, maxAgeMonths, now = new Date()) {
  const pub = new Date(publishedAt);
  if (Number.isNaN(pub.getTime())) return false;
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - maxAgeMonths);
  return pub < cutoff;
}

/** True when a duration exceeds the hard cap. */
export function exceedsDurationCap(seconds, cap = DURATION_CAP_SECONDS) {
  return seconds > cap;
}

// --- Config validation (pure; throw with a clear, file-named message on invalid input) ---

export function validateChannelsConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('config/channels.json: not a JSON object');
  if (!Array.isArray(cfg.channels)) throw new Error('config/channels.json: "channels" must be an array');
  if (cfg.channels.length === 0) throw new Error('config/channels.json: "channels" is empty — add at least one channel');
  cfg.channels.forEach((c, i) => {
    if (!c || typeof c.id !== 'string' || !/^UC/.test(c.id)) {
      throw new Error(`config/channels.json: channels[${i}].id must be a string starting with "UC"`);
    }
  });
  if (!Number.isFinite(cfg.maxVideosPerChannel) || cfg.maxVideosPerChannel <= 0) {
    throw new Error('config/channels.json: "maxVideosPerChannel" must be a positive number');
  }
  if (!Number.isFinite(cfg.maxAgeMonths) || cfg.maxAgeMonths <= 0) {
    throw new Error('config/channels.json: "maxAgeMonths" must be a positive number');
  }
  return cfg;
}

export function validateDenylistConfig(cfg) {
  if (!cfg || !Array.isArray(cfg.keywords)) throw new Error('config/denylist.json: "keywords" must be an array');
  cfg.keywords.forEach((k, i) => {
    if (typeof k !== 'string' || k.trim() === '') {
      throw new Error(`config/denylist.json: keywords[${i}] must be a non-empty string (a blank keyword would drop every video)`);
    }
  });
  return cfg;
}

export function validateBlocklistConfig(cfg) {
  if (!cfg || !Array.isArray(cfg.videoIds)) throw new Error('config/blocklist.json: "videoIds" must be an array');
  return cfg;
}

/**
 * Run all drift guardrails over the candidate list and bucket the survivors.
 * Pure: no I/O, deterministic given `now`. First matching drop reason wins, so
 * `candidates.length === videos.length + drops.length` always holds.
 *
 * Returns { videos, drops } where each drop is { id, reason, detail? }.
 */
export function filterAndBucket(candidates, { blocklist = [], keywords = [], maxAgeMonths, now = new Date(), durationCap = DURATION_CAP_SECONDS }) {
  const blockset = new Set(blocklist);
  const videos = [];
  const drops = [];

  for (const c of candidates) {
    if (blockset.has(c.id)) {
      drops.push({ id: c.id, reason: 'blocklist' });
      continue;
    }
    const kw = matchesDenylist(c.title, c.description, keywords);
    if (kw) {
      drops.push({ id: c.id, reason: 'denylist', detail: kw });
      continue;
    }
    if (c.privacyStatus && c.privacyStatus !== 'public') {
      drops.push({ id: c.id, reason: 'unavailable', detail: c.privacyStatus });
      continue;
    }
    if (c.durationSeconds == null) {
      drops.push({ id: c.id, reason: 'no-duration' });
      continue;
    }
    if (isTooOld(c.publishedAt, maxAgeMonths, now)) {
      drops.push({ id: c.id, reason: 'age' });
      continue;
    }
    if (exceedsDurationCap(c.durationSeconds, durationCap)) {
      drops.push({ id: c.id, reason: 'duration-cap' });
      continue;
    }
    videos.push({
      id: c.id,
      title: c.title,
      channel: c.channelLabel,
      durationSeconds: c.durationSeconds,
      bucket: bucketFor(c.durationSeconds),
      publishedAt: c.publishedAt,
      thumbnail: c.thumbnail,
    });
  }

  return { videos, drops };
}

/** Aggregate drops into a reason -> count map for the build report. */
export function dropSummary(drops) {
  const counts = {};
  for (const d of drops) counts[d.reason] = (counts[d.reason] || 0) + 1;
  return counts;
}
