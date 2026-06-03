'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { getDispatcherFactory } = require('../dispatch');
const { jobName, buildJob } = require('../dispatch/k8s-job');

// --- registry ----------------------------------------------------------------
test('dispatch registry resolves k8s-job (default) + exec; throws on unknown', () => {
  assert.strictEqual(getDispatcherFactory(undefined).name, 'k8s-job');
  assert.strictEqual(getDispatcherFactory('exec').name, 'exec');
  assert.throws(() => getDispatcherFactory('nope'), /unknown DISPATCH/);
});

// --- k8s-job: deterministic name = the dedupe key ----------------------------
test('jobName is deterministic, RFC-1123, and <=63 chars', () => {
  const a = jobName('agent-run', 'WID-123/KAN-5');
  const b = jobName('agent-run', 'WID-123/KAN-5');
  assert.strictEqual(a, b, 'same delivery id → same Job name (that is the dedupe)');
  assert.match(a, /^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'lowercase RFC-1123');
  assert.ok(a.length <= 63);
  const long = jobName('agent-run', 'x'.repeat(200));
  assert.ok(long.length <= 63);
});

test('buildJob carries the runner inputs as env + run-once Job spec', () => {
  const job = buildJob({
    name: 'agent-run-kan-5',
    namespace: 'triage',
    cfg: { managedBy: 'agent-runner', runnerServiceAccount: 'agent-runner', image: 'repo:tag', backoffLimit: 1, ttlSeconds: 3600, activeDeadlineSeconds: 300, resources: {} },
    vars: { key: 'KAN-5' },
    label: 'KAN-5',
    agentPath: '/agents/jira-triage',
    harness: 'pi',
    model: 'us.anthropic.claude-sonnet-4-6',
  });
  assert.strictEqual(job.kind, 'Job');
  assert.strictEqual(job.spec.template.spec.restartPolicy, 'Never');
  assert.strictEqual(job.spec.backoffLimit, 1);
  assert.strictEqual(job.spec.ttlSecondsAfterFinished, 3600);
  const env = Object.fromEntries(job.spec.template.spec.containers[0].env.map((e) => [e.name, e.value]));
  assert.strictEqual(env.AGENT_PATH, '/agents/jira-triage');
  assert.strictEqual(env.HARNESS, 'pi');
  assert.deepStrictEqual(JSON.parse(env.RUN_VARS), { key: 'KAN-5' });
  assert.strictEqual(env.MODEL, 'us.anthropic.claude-sonnet-4-6');
});

// --- exec dispatcher: in-memory dedupe + limit -------------------------------
const { createDispatcher } = require('../dispatch/exec');

// A fake child that never fires 'close' — keeps the limiter slot held so the
// concurrency assertion is deterministic (no real process timing).
function fakeSpawn() {
  return { on() {}, kill() {} };
}

test('exec dispatcher dedupes a repeated delivery id', async () => {
  const d = createDispatcher({ maxConcurrent: 5, ceiling: 100, dailyBudget: 100, log: () => {}, spawn: fakeSpawn });
  const first = await d({ vars: {}, dedupeId: 'dup-1', label: 'x', agentPath: '/x', harness: 'pi' });
  const second = await d({ vars: {}, dedupeId: 'dup-1', label: 'x', agentPath: '/x', harness: 'pi' });
  assert.strictEqual(first.accepted, true);
  assert.strictEqual(second.duplicate, true);
});

test('exec dispatcher enforces the concurrency limit', async () => {
  const d = createDispatcher({ maxConcurrent: 1, ceiling: 100, dailyBudget: 100, log: () => {}, spawn: fakeSpawn });
  const a = await d({ vars: {}, dedupeId: 'a', label: 'a', agentPath: '/x', harness: 'pi' });
  const b = await d({ vars: {}, dedupeId: 'b', label: 'b', agentPath: '/x', harness: 'pi' });
  assert.strictEqual(a.accepted, true);
  assert.strictEqual(b.accepted, false);
  assert.strictEqual(b.limited, 'concurrency');
});
