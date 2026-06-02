'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { DedupeCache, SpawnLimiter } = require('../listener/limits');

// --- dedupe (R8) -------------------------------------------------------------
test('duplicate identifier is detected; TTL floor is >=24h', () => {
  let now = 1_000_000;
  const c = new DedupeCache(60_000, () => now); // ask for 60s, floor forces 24h
  assert.strictEqual(c.seenBefore('id-1'), false);
  assert.strictEqual(c.seenBefore('id-1'), true);
  now += 23 * 60 * 60 * 1000; // 23h — still within the floor
  assert.strictEqual(c.seenBefore('id-1'), true);
  now += 2 * 60 * 60 * 1000; // 25h — expired
  assert.strictEqual(c.seenBefore('id-1'), false);
});

test('absent identifier is not deduped (let through)', () => {
  const c = new DedupeCache();
  assert.strictEqual(c.seenBefore(undefined), false);
  assert.strictEqual(c.seenBefore(''), false);
});

// --- limiter (R10c) ----------------------------------------------------------
test('semaphore blocks beyond max concurrency', () => {
  const l = new SpawnLimiter({ maxConcurrent: 2, ceiling: 100 });
  assert.strictEqual(l.tryAcquire().ok, true);
  assert.strictEqual(l.tryAcquire().ok, true);
  const third = l.tryAcquire();
  assert.strictEqual(third.ok, false);
  assert.strictEqual(third.reason, 'concurrency');
  l.release();
  assert.strictEqual(l.tryAcquire().ok, true);
});

test('global rate ceiling blocks a storm regardless of concurrency', () => {
  let now = 0;
  const l = new SpawnLimiter({ maxConcurrent: 100, ceiling: 3, windowMs: 1000, dailyBudget: 1000, now: () => now });
  for (let i = 0; i < 3; i++) { assert.strictEqual(l.tryAcquire().ok, true); l.release(); }
  const fourth = l.tryAcquire();
  assert.strictEqual(fourth.ok, false);
  assert.strictEqual(fourth.reason, 'rate-ceiling');
  now += 1001; // window rolls
  assert.strictEqual(l.tryAcquire().ok, true);
});

test('daily budget caps total spawns even under the per-minute ceiling', () => {
  let now = 0;
  const l = new SpawnLimiter({ maxConcurrent: 100, ceiling: 100, windowMs: 1000, dailyBudget: 2, now: () => now });
  assert.strictEqual(l.tryAcquire().ok, true);
  l.release();
  now += 2000; // roll the per-minute window so rate-ceiling can't be the blocker
  assert.strictEqual(l.tryAcquire().ok, true);
  l.release();
  now += 2000;
  const third = l.tryAcquire();
  assert.strictEqual(third.ok, false);
  assert.strictEqual(third.reason, 'daily-budget');
  now += 24 * 60 * 60 * 1000 + 1; // a day later — budget resets
  assert.strictEqual(l.tryAcquire().ok, true);
});
