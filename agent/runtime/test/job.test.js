'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { buildJob, jobName } = require('../lib/job');

// --- jobName -----------------------------------------------------------------
test('jobName is deterministic and k8s-safe (≤63 chars, [a-z0-9-])', () => {
  const a = jobName('jira-triage', 'KAN-5/2026-06-03T10:00:00Z');
  const b = jobName('jira-triage', 'KAN-5/2026-06-03T10:00:00Z');
  assert.strictEqual(a, b, 'same id → same name (this IS the dedupe key)');
  assert.notStrictEqual(a, jobName('jira-triage', 'KAN-6/...'));
  assert.ok(a.length <= 63);
  assert.match(a, /^[a-z0-9][a-z0-9-]*$/);
});

// --- buildJob ----------------------------------------------------------------
test('buildJob produces a one-shot Job with RUN_VARS + K8s-owned guards', () => {
  const j = buildJob({
    name: 'jira-triage-abc123',
    image: 'repo/agent:jira-triage-pi',
    vars: { key: 'KAN-5' },
    env: [{ name: 'KIRO_API_KEY', value: 'x' }],
  });
  assert.strictEqual(j.kind, 'Job');
  assert.strictEqual(j.metadata.name, 'jira-triage-abc123');
  const spec = j.spec;
  // K8s replaces the old in-process guards:
  assert.strictEqual(spec.backoffLimit, 1); // retries
  assert.ok(spec.activeDeadlineSeconds > 0); // the watchdog
  assert.ok(spec.ttlSecondsAfterFinished > 0); // cleanup
  const c = spec.template.spec.containers[0];
  assert.strictEqual(c.image, 'repo/agent:jira-triage-pi');
  // Must override the image's default CMD (receiver) → the run entrypoint.
  assert.deepStrictEqual(c.command, ['node', 'runtime/run.js']);
  assert.strictEqual(spec.template.spec.restartPolicy, 'Never');
  // RUN_VARS carries the trigger vars; extra env is appended.
  const runVars = c.env.find((e) => e.name === 'RUN_VARS');
  assert.deepStrictEqual(JSON.parse(runVars.value), { key: 'KAN-5' });
  assert.ok(c.env.some((e) => e.name === 'KIRO_API_KEY'));
});

test('buildJob: secret via envFrom, config MOUNTED as a file (not envFrom)', () => {
  const j = buildJob({
    name: 'a-1',
    image: 'repo/agent:x',
    vars: {},
    secretName: 'agent-secrets',
    configMapName: 'agent-config',
  });
  const podSpec = j.spec.template.spec;
  const c = podSpec.containers[0];
  // Secret: envFrom (flat keys → env vars).
  assert.ok(c.envFrom.some((e) => e.secretRef && e.secretRef.name === 'agent-secrets'));
  // Config: a volume mounted at /etc/triage, NOT envFrom (config.json is a file).
  assert.ok(!c.envFrom.some((e) => e.configMapRef), 'config must NOT be envFrom');
  assert.ok(podSpec.volumes.some((v) => v.configMap && v.configMap.name === 'agent-config'));
  const mount = c.volumeMounts.find((m) => m.mountPath === '/etc/triage');
  assert.ok(mount && mount.readOnly);
});
