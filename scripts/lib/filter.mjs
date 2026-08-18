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

/**
 * Case-insensitive substring match of any denylist keyword against title+description.
 * Returns the matched keyword (truthy) or null (no match) so callers can log the reason.
 */
export function matchesDenylist(title, description, keywords) {
  const hay = `${title || ''} ${description || ''}`.toLowerCase();
  for (const k of keywords) {
    if (hay.includes(String(k).toLowerCase())) return k;
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
  return cfg;
}

export function validateBlocklistConfig(cfg) {
  if (!cfg || !Array.isArray(cfg.videoIds)) throw new Error('config/blocklist.json: "videoIds" must be an array');
  return cfg;
}
