import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_OPTIONS,
  sessionFor,
  buildPool,
  shouldContinue,
  buildReportTarget,
  nextStep,
  TOP_UP_SECONDS,
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

test('shouldContinue stops advancing once cumulative reaches budget', () => {
  assert.equal(shouldContinue(0, 120), true);
  assert.equal(shouldContinue(119, 120), true);
  assert.equal(shouldContinue(120, 120), false);
  assert.equal(shouldContinue(200, 120), false);
});

test('nextStep advances while under budget, accumulating watch time', () => {
  const step = nextStep({ index: 0, cumulativeSeconds: 30, poolLength: 5, budgetSeconds: 120 }, 40);
  assert.deepEqual(step, { action: 'advance', index: 1, cumulativeSeconds: 70 });
});

test('nextStep ends the session once the budget is reached', () => {
  const step = nextStep({ index: 1, cumulativeSeconds: 90, poolLength: 5, budgetSeconds: 120 }, 40);
  assert.equal(step.action, 'end');
  assert.equal(step.cumulativeSeconds, 130);
});

test('nextStep ends the session when the pool is exhausted even under budget', () => {
  const step = nextStep({ index: 4, cumulativeSeconds: 10, poolLength: 5, budgetSeconds: 600 }, 20);
  assert.equal(step.action, 'end');
  assert.equal(step.index, 5);
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
