'use strict';

// Build the Job manifest for one run. Pure (no I/O) so it's trivially testable.
//
// The Job NAME is derived deterministically from the dedupe id — creating it
// twice yields a 409 from the API, which is our entire dedupe mechanism. K8s
// fields replace what used to be in-process: activeDeadlineSeconds = the
// watchdog, backoffLimit = retries, ttlSecondsAfterFinished = cleanup.

const crypto = require('crypto');

// K8s names: ≤63 chars, [a-z0-9-]. Hash the (possibly long/odd) dedupe id into a
// stable suffix and keep a readable prefix.
function jobName(prefix, dedupeId) {
  const hash = crypto.createHash('sha256').update(String(dedupeId)).digest('hex').slice(0, 16);
  const base = String(prefix || 'run').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
  return `${base}-${hash}`.replace(/^-+/, '');
}

/**
 * buildJob({ name, image, vars, env, namespace, serviceAccount, ttl, deadline, backoff })
 * → a batch/v1 Job manifest that runs the agent image once with RUN_VARS set.
 */
function buildJob(opts) {
  const {
    name,
    image,
    vars,
    env = [], // NON-secret literal env (e.g. HARNESS, MODEL)
    secretName, // Job pulls creds from this Secret via envFrom — NOT copied here
    configMapName, // optional: allowed-value config via envFrom
    serviceAccount = 'agent-runner',
    ttl = 3600, // delete finished Jobs after 1h
    deadline = 600, // hard wall-clock cap per run (the old watchdog)
    backoff = 1, // one retry on failure
  } = opts;

  // The receiver never sees secret VALUES: the run pod loads them itself via
  // envFrom. The receiver only stamps the (non-secret) vars + which secret to use.
  const envFrom = [];
  if (secretName) envFrom.push({ secretRef: { name: secretName } });
  if (configMapName) envFrom.push({ configMapRef: { name: configMapName } });

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, labels: { 'app.kubernetes.io/name': 'agent-run' } },
    spec: {
      backoffLimit: backoff,
      activeDeadlineSeconds: deadline,
      ttlSecondsAfterFinished: ttl,
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'agent-run' } },
        spec: {
          restartPolicy: 'Never',
          serviceAccountName: serviceAccount,
          containers: [
            {
              name: 'run',
              image,
              // RUN_VARS carries the trigger's parsed vars to run.js.
              env: [{ name: 'RUN_VARS', value: JSON.stringify(vars || {}) }, ...env],
              ...(envFrom.length ? { envFrom } : {}),
            },
          ],
        },
      },
    },
  };
}

module.exports = { buildJob, jobName };
