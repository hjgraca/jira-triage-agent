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
    configMapName, // allowed-value config, MOUNTED AS A FILE at configMountPath
    configMountPath = '/etc/triage', // where the skill reads config.json (TRIAGE_CONFIG)
    imagePullSecret, // optional: name of a docker-registry Secret for private registries (Nexus/Harbor/…)
    serviceAccount = 'agent-runner',
    ttl = 3600, // delete finished Jobs after 1h
    deadline = 600, // hard wall-clock cap per run (the old watchdog)
    backoff = 1, // one retry on failure
  } = opts;

  // Secrets: flat key/value, injected via envFrom — the receiver never sees the
  // values. Config: the skill reads it as a FILE (config.json), so the ConfigMap
  // is mounted as a volume, not envFrom (a `config.json` key isn't a valid env name).
  const envFrom = secretName ? [{ secretRef: { name: secretName } }] : [];
  const volumes = [];
  const volumeMounts = [];
  if (configMapName) {
    volumes.push({ name: 'config', configMap: { name: configMapName } });
    volumeMounts.push({ name: 'config', mountPath: configMountPath, readOnly: true });
  }

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
          // Private registry (Nexus/Harbor/…): the kubelet needs a pull secret to
          // fetch the run image. Omitted entirely for public/ECR-on-node-role pulls.
          ...(imagePullSecret ? { imagePullSecrets: [{ name: imagePullSecret }] } : {}),
          ...(volumes.length ? { volumes } : {}),
          containers: [
            {
              name: 'run',
              image,
              // The image's default CMD is the receiver; a run Job is the OTHER
              // entrypoint, so override the command explicitly.
              command: ['node', 'runtime/run.js'],
              // RUN_VARS carries the trigger's parsed vars to run.js.
              env: [{ name: 'RUN_VARS', value: JSON.stringify(vars || {}) }, ...env],
              ...(envFrom.length ? { envFrom } : {}),
              ...(volumeMounts.length ? { volumeMounts } : {}),
            },
          ],
        },
      },
    },
  };
}

module.exports = { buildJob, jobName };
