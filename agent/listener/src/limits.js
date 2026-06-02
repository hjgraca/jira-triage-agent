'use strict';

// In-memory dedupe cache and spawn limiter. State is intentionally in-memory
// and lost on pod restart (documented caveat) — the stateless self-write marker
// in gate.js keeps the loop guard working during the cold-start window.

/**
 * TTL dedupe on X-Atlassian-Webhook-Identifier (R8). Floor of 24h so Jira's
 * retry window (up to ~hours) can never replay past the cache, and a captured
 * signed body can't be replayed after expiry within that window.
 */
class DedupeCache {
  constructor(ttlMs = 24 * 60 * 60 * 1000, now = Date.now) {
    this.ttlMs = Math.max(ttlMs, 24 * 60 * 60 * 1000); // enforce the >=24h floor
    this.now = now;
    this.seen = new Map(); // id -> expiry epoch ms
  }

  /** Returns true if this id was already seen (and not expired). Records it otherwise. */
  seenBefore(id) {
    if (!id) return false; // no identifier → can't dedupe; let it through
    const t = this.now();
    const exp = this.seen.get(id);
    if (exp !== undefined && exp > t) return true;
    this.seen.set(id, t + this.ttlMs);
    return false;
  }

  /** Remove an id so a redelivery can be reprocessed (e.g. after a failed spawn). */
  evict(id) {
    if (id) this.seen.delete(id);
  }

  /** Drop expired entries (call periodically to bound memory). */
  sweep() {
    const t = this.now();
    for (const [id, exp] of this.seen) if (exp <= t) this.seen.delete(id);
  }
}

/**
 * Spawn limiter: a max-concurrency semaphore (R10c) AND a global rate ceiling
 * over a rolling window (defense against a loop/label-storm regardless of
 * cache state). tryAcquire() returns false when either bound is hit; the caller
 * then drops the webhook with a logged 200 rather than spawning.
 */
class SpawnLimiter {
  constructor({
    maxConcurrent = 3,
    ceiling = 60,
    windowMs = 60 * 1000,
    dailyBudget = 500,
    now = Date.now,
  } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.ceiling = ceiling;
    this.windowMs = windowMs;
    // Cumulative daily spawn budget — a hard ceiling on billable Bedrock runs
    // per 24h that the rolling-window rate limit alone can't bound (a steady
    // drip under the per-minute ceiling could still rack up cost all day, and
    // issue_created has no per-actor authz). Resets on a rolling 24h window.
    this.dailyBudget = dailyBudget;
    this.now = now;
    this.active = 0;
    this.starts = []; // epoch ms of recent spawns (rolling window)
    this.day = []; // epoch ms of spawns in the last 24h
  }

  _trim() {
    const t = this.now();
    const cutoff = t - this.windowMs;
    while (this.starts.length && this.starts[0] <= cutoff) this.starts.shift();
    const dayCutoff = t - 24 * 60 * 60 * 1000;
    while (this.day.length && this.day[0] <= dayCutoff) this.day.shift();
  }

  tryAcquire() {
    this._trim();
    if (this.active >= this.maxConcurrent) return { ok: false, reason: 'concurrency' };
    if (this.starts.length >= this.ceiling) return { ok: false, reason: 'rate-ceiling' };
    if (this.day.length >= this.dailyBudget) return { ok: false, reason: 'daily-budget' };
    const t = this.now();
    this.active += 1;
    this.starts.push(t);
    this.day.push(t);
    return { ok: true };
  }

  release() {
    if (this.active > 0) this.active -= 1;
  }
}

module.exports = { DedupeCache, SpawnLimiter };
