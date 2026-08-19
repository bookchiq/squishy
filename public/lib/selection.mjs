// Pure, DOM-free session-selection logic. Imported by the browser front-end
// (app.js) and by node:test. No document access, no fetch.

/**
 * Session length -> watch budget + ordered bucket preference.
 * 2 min favors short clips; 10 min leans into longer, calmer watches.
 */
export const SESSION_OPTIONS = [
  { minutes: 2, budgetSeconds: 120, preference: ['short'] },
  { minutes: 5, budgetSeconds: 300, preference: ['short', 'medium'] },
  { minutes: 10, budgetSeconds: 600, preference: ['medium', 'long'] },
];

export function sessionFor(minutes) {
  return SESSION_OPTIONS.find((o) => o.minutes === minutes) || null;
}

function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Build the eligible play pool for a session preference.
 * - Videos in `exclude` (already-seen IDs) are dropped first; if that would
 *   leave nothing, the exclusion is ignored so the viewer still gets something.
 * - Preferred-bucket videos come first, shuffled.
 * - When the preferred pool is thin, remaining videos follow ordered
 *   SHORTEST-FIRST, so a 2-minute session never opens with a 20-minute video.
 * - Duplicate video IDs are removed.
 */
export function buildPool(videos, preference, rng = Math.random, exclude = new Set()) {
  const pickedIds = new Set();
  const uniq = [];
  for (const v of videos || []) {
    if (v && v.id && !pickedIds.has(v.id)) {
      pickedIds.add(v.id);
      uniq.push(v);
    }
  }
  // Prefer unseen videos; fall back to the full set only if everything is seen.
  let pool = uniq.filter((v) => !exclude.has(v.id));
  if (pool.length === 0) pool = uniq;

  const pref = new Set(preference);
  const preferred = pool.filter((v) => pref.has(v.bucket));
  const rest = pool
    .filter((v) => !pref.has(v.bucket))
    .sort((a, b) => (a.durationSeconds || 0) - (b.durationSeconds || 0));
  return [...shuffle(preferred, rng), ...rest];
}

// --- "Already seen" store (persisted by the front-end in localStorage) -------
export const SEEN_TTL_DAYS = 45;
export const SEEN_MAX = 500;

/** Drop entries older than the TTL and cap to the most-recent `max`. Pure. */
export function pruneSeen(entries, { now, ttlDays = SEEN_TTL_DAYS, max = SEEN_MAX } = {}) {
  const cutoff = now - ttlDays * 86400000;
  const fresh = (entries || []).filter(
    (e) => e && typeof e.id === 'string' && typeof e.ts === 'number' && e.ts >= cutoff
  );
  fresh.sort((a, b) => b.ts - a.ts);
  return fresh.slice(0, max);
}

/** Record `id` as seen at `now`, most-recent first, de-duplicated. Pure. */
export function addSeen(entries, id, now) {
  const without = (entries || []).filter((e) => e.id !== id);
  without.unshift({ id, ts: now });
  return without;
}

/** Continue advancing while cumulative watch time is under budget. */
export function shouldContinue(cumulativeSeconds, budgetSeconds) {
  return cumulativeSeconds < budgetSeconds;
}

/** A small, bounded budget for the "a few more?" gentle top-up. */
export const TOP_UP_SECONDS = 120;

/**
 * Decide what happens after a video finishes: add its duration to the running
 * total, then either advance to the next pool item or end the session (budget
 * reached, or the pool is exhausted). Pure — the caller applies the returned state.
 */
export function nextStep({ index, cumulativeSeconds, poolLength, budgetSeconds }, endedDurationSeconds) {
  const cumulative = cumulativeSeconds + (Number(endedDurationSeconds) || 0);
  if (!shouldContinue(cumulative, budgetSeconds)) {
    return { action: 'end', index, cumulativeSeconds: cumulative };
  }
  const nextIndex = index + 1;
  if (nextIndex >= poolLength) {
    return { action: 'end', index: nextIndex, cumulativeSeconds: cumulative };
  }
  return { action: 'advance', index: nextIndex, cumulativeSeconds: cumulative };
}

/**
 * Build a prefilled mailto for the "report this video" affordance.
 * Everything is URL-encoded so a crafted title cannot inject mail headers.
 */
export function buildReportTarget(video, maintainerEmail = 'you@example.com') {
  const subject = `Report a video for review: ${video.id}`;
  const body = [
    'Please review this video for the blocklist:',
    '',
    `Title: ${video.title}`,
    `Video ID: ${video.id}`,
    `URL: https://youtu.be/${video.id}`,
  ].join('\n');
  const mailto =
    `mailto:${encodeURIComponent(maintainerEmail)}` +
    `?subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`;
  return { subject, body, mailto };
}
