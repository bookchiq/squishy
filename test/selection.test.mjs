import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_OPTIONS,
  sessionFor,
  buildPool,
  shouldContinue,
  buildReportTarget,
  chooseNextIndex,
  overshootAllowance,
  TOP_UP_SECONDS,
  pruneSeen,
  addSeen,
} from '../public/lib/selection.mjs';

const vid = (id, bucket, durationSeconds) => ({ id, bucket, durationSeconds, title: id, channel: 'c' });

test('SESSION_OPTIONS map lengths to budgets and bucket preferences', () => {
  assert.deepEqual(sessionFor(2), { minutes: 2, budgetSeconds: 120, preference: ['short'] });
  assert.equal(sessionFor(5).budgetSeconds, 300);
  assert.deepEqual(sessionFor(10).preference, ['medium', 'long']);
  assert.equal(sessionFor(99), null);
  assert.equal(SESSION_OPTIONS.length, 3);
});

test('buildPool draws from the preferred bucket first', () => {
  const videos = [vid('s1', 'short', 30), vid('s2', 'short', 40), vid('m1', 'medium', 120)];
  const pool = buildPool(videos, ['short'], () => 0);
  assert.equal(pool.length, 3);
  // First two are the shorts (preferred); medium is the fallback tail.
  assert.deepEqual(pool.slice(0, 2).map((v) => v.bucket).sort(), ['short', 'short']);
  assert.equal(pool[2].id, 'm1');
});

test('buildPool falls back shortest-first when the preferred bucket is empty', () => {
  const videos = [vid('l1', 'long', 1000), vid('m1', 'medium', 200), vid('l2', 'long', 800)];
  const pool = buildPool(videos, ['short'], () => 0);
  // Preferred (short) is empty -> everything is fallback, ordered shortest-first.
  assert.deepEqual(pool.map((v) => v.id), ['m1', 'l2', 'l1']);
});

test('buildPool returns [] when there are no videos', () => {
  assert.deepEqual(buildPool([], ['short']), []);
  assert.deepEqual(buildPool(null, ['short']), []);
});

test('buildPool de-duplicates repeated video IDs', () => {
  const videos = [vid('s1', 'short', 30), vid('s1', 'short', 30), vid('s2', 'short', 40)];
  const pool = buildPool(videos, ['short'], () => 0);
  assert.equal(pool.length, 2);
  assert.deepEqual(pool.map((v) => v.id).sort(), ['s1', 's2']);
});

test('buildPool orders the preferred bucket by score, most-liked first', () => {
  const videos = [
    { id: 'a', bucket: 'short', durationSeconds: 30, score: 1 },
    { id: 'b', bucket: 'short', durationSeconds: 30, score: 9 },
    { id: 'c', bucket: 'short', durationSeconds: 30, score: 5 },
  ];
  const pool = buildPool(videos, ['short'], () => 0);
  assert.deepEqual(pool.map((v) => v.id), ['b', 'c', 'a']);
});

test('buildPool treats a missing score as 0', () => {
  const videos = [
    { id: 'a', bucket: 'short', durationSeconds: 30 },
    { id: 'b', bucket: 'short', durationSeconds: 30, score: 3 },
  ];
  const pool = buildPool(videos, ['short'], () => 0);
  assert.equal(pool[0].id, 'b', 'the voted video leads the unvoted one');
});

test('buildPool excludes already-seen videos', () => {
  const videos = [vid('s1', 'short', 30), vid('s2', 'short', 40), vid('s3', 'short', 50)];
  const pool = buildPool(videos, ['short'], () => 0, new Set(['s1', 's2']));
  assert.deepEqual(pool.map((v) => v.id), ['s3']);
});

test('buildPool ignores the exclusion when every video has been seen (shows something)', () => {
  const videos = [vid('s1', 'short', 30), vid('s2', 'short', 40)];
  const pool = buildPool(videos, ['short'], () => 0, new Set(['s1', 's2']));
  assert.equal(pool.length, 2, 'falls back to the full set rather than showing nothing');
});

test('pruneSeen drops entries older than the TTL and caps the count', () => {
  const now = 1_000_000_000_000;
  const day = 86400000;
  const entries = [
    { id: 'fresh', ts: now - 1 * day },
    { id: 'stale', ts: now - 60 * day }, // older than 45-day TTL
  ];
  const pruned = pruneSeen(entries, { now });
  assert.deepEqual(pruned.map((e) => e.id), ['fresh']);

  const many = Array.from({ length: 10 }, (_, i) => ({ id: `v${i}`, ts: now - i }));
  assert.equal(pruneSeen(many, { now, max: 3 }).length, 3);
  assert.deepEqual(pruneSeen(many, { now, max: 3 }).map((e) => e.id), ['v0', 'v1', 'v2']);
});

test('addSeen records most-recent-first and de-duplicates', () => {
  let entries = [];
  entries = addSeen(entries, 'a', 100);
  entries = addSeen(entries, 'b', 200);
  entries = addSeen(entries, 'a', 300); // re-seen — moves to front, no dupe
  assert.deepEqual(entries.map((e) => e.id), ['a', 'b']);
  assert.equal(entries[0].ts, 300);
});

test('shouldContinue stops advancing once cumulative reaches budget', () => {
  assert.equal(shouldContinue(0, 120), true);
  assert.equal(shouldContinue(119, 120), true);
  assert.equal(shouldContinue(120, 120), false);
  assert.equal(shouldContinue(200, 120), false);
});

const vd = (id, durationSeconds) => ({ id, durationSeconds });

test('overshootAllowance is the greater of 15% of budget or 60s', () => {
  assert.equal(overshootAllowance(120), 60); // 15% = 18 -> floor 60
  assert.equal(overshootAllowance(600), 90); // 15% = 90
  assert.equal(overshootAllowance(1200), 180); // 15% = 180
});

test('chooseNextIndex plays the head when its overshoot is within the allowance', () => {
  // 2-min budget, 10s left; head 45s overshoots by 35 <= 60 allowance -> keep the head.
  const queue = [vd('a', 45), vd('b', 20), vd('c', 300)];
  assert.equal(chooseNextIndex(queue, 10, 120), 0);
});

test('chooseNextIndex swaps to the shortest just-over video when the head overshoots too much', () => {
  // 10-min budget, 30s left; head 300s overshoots by 270 > 90. Shortest video still >= 30s is b(40).
  const queue = [vd('a', 300), vd('b', 40), vd('c', 120)];
  assert.equal(chooseNextIndex(queue, 30, 600), 1);
});

test('chooseNextIndex keeps the head when no shorter video still goes over', () => {
  // head overshoots too much, but the only other video is shorter than the remaining time.
  const queue = [vd('a', 300), vd('b', 10)];
  assert.equal(chooseNextIndex(queue, 60, 120), 0);
});

test('chooseNextIndex returns -1 for an empty queue', () => {
  assert.equal(chooseNextIndex([], 60, 120), -1);
});

test('TOP_UP_SECONDS bounds the "a few more?" top-up', () => {
  assert.equal(typeof TOP_UP_SECONDS, 'number');
  assert.ok(TOP_UP_SECONDS > 0 && TOP_UP_SECONDS <= 300);
});

test('buildReportTarget URL-encodes a crafted title so it cannot inject mail headers', () => {
  const evil = { id: 'abc123', title: 'Cute\n&cc=attacker@x.com otter' };
  const { mailto, body } = buildReportTarget(evil, 'maintainer@example.com');
  assert.ok(mailto.startsWith('mailto:maintainer%40example.com?'));
  assert.ok(mailto.includes('abc123'));
  assert.ok(!mailto.includes('\n'), 'no raw newline in mailto');
  assert.ok(!mailto.includes('&cc='), 'crafted header must be encoded, not literal');
  assert.ok(body.includes('abc123'));
});
