'use strict';

// K8s Job dispatcher: one-shot run = one Kubernetes Job. This is the production
// path. Kubernetes itself provides what the old in-memory listener did:
//   - DEDUPE: the Job is named deterministically from the delivery id, so a
//     duplicate delivery → 409 AlreadyExists → we treat it as a no-op.
//   - CONCURRENCY LIMIT: a namespace ResourceQuota caps concurrent run pods;
//     excess Jobs queue until slots free (no in-memory semaphore needed).
//   - ISOLATION + CLEANUP: each run is its own pod (ttlSecondsAfterFinished),
//     retried via backoffLimit.
//
// Talks to the in-cluster API server directly with the pod's projected
// ServiceAccount token — no client library dependency (keeps the engine
// zero-dep). The receiver's SA needs RBAC to create Jobs (see deploy/k8s).

const fs = require('fs');

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const API = 'https://kubernetes.default.svc';

function readSA() {
  const token = fs.readFileSync(`${SA_DIR}/token`, 'utf8').trim();
  const namespace = fs.readFileSync(`${SA_DIR}/namespace`, 'utf8').trim();
  const ca = `${SA_DIR}/ca.crt`;
  return { token, namespace, ca };
}

// K8s names: lowercase RFC-1123, <=63 chars. Hash-free deterministic transform
// so the same delivery id always maps to the same Job name (that's the dedupe).
function jobName(prefix, dedupeId) {
  const safe = String(dedupeId || 'run')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'run';
  return `${prefix}-${safe}`.slice(0, 63).replace(/-+$/g, '');
}

/**
 * Build the Job manifest for one run. Env carries the runner's inputs; the
 * image, SA, resources, ttl, and backoff come from config (env on the receiver,
 * passed through so the operator controls them in one place).
 */
function buildJob({ name, namespace, cfg, vars, label, agentPath, harness, model }) {
  const env = [
    { name: 'AGENT_PATH', value: agentPath },
    { name: 'HARNESS', value: harness },
    { name: 'RUN_VARS', value: JSON.stringify(vars) },
    { name: 'RUN_LABEL', value: String(label) },
  ];
  if (model) env.push({ name: 'MODEL', value: model });

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name,
      namespace,
      labels: { 'app.kubernetes.io/name': 'agent-run', 'app.kubernetes.io/managed-by': cfg.managedBy },
    },
    spec: {
      backoffLimit: cfg.backoffLimit,
      ttlSecondsAfterFinished: cfg.ttlSeconds,
      activeDeadlineSeconds: cfg.activeDeadlineSeconds,
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'agent-run' } },
        spec: {
          restartPolicy: 'Never',
          serviceAccountName: cfg.runnerServiceAccount,
          securityContext: { runAsNonRoot: true, runAsUser: 10001, fsGroup: 10001 },
          containers: [
            {
              name: 'runner',
              image: cfg.image,
              command: ['node', 'runtime/runner/main.js'],
              env,
              envFrom: cfg.envFrom, // secret/config the agent needs (e.g. credentials)
              volumeMounts: cfg.volumeMounts,
              resources: cfg.resources,
            },
          ],
          volumes: cfg.volumes,
        },
      },
    },
  };
}

function createDispatcher(cfg) {
  const { token, namespace } = readSA();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  // TLS to the API server: the deployment sets NODE_EXTRA_CA_CERTS to the SA's
  // ca.crt (see deploy/k8s), so global fetch trusts the in-cluster CA. We assert
  // it here so a misconfigured deployment fails loudly rather than on first POST.
  if (!process.env.NODE_EXTRA_CA_CERTS) {
    throw new Error(
      'NODE_EXTRA_CA_CERTS must point at the in-cluster SA ca.crt for the k8s-job dispatcher'
    );
  }

  return async function dispatch({ vars, dedupeId, label, agentPath, harness, model }) {
    const name = jobName(cfg.namePrefix, dedupeId);
    const body = buildJob({ name, namespace, cfg, vars, label, agentPath, harness, model });
    const resp = await fetch(`${API}/apis/batch/v1/namespaces/${namespace}/jobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      // Node fetch honors NODE_EXTRA_CA_CERTS; we also pass the CA explicitly via
      // a dispatcher-level agent when available. Bound the call so a wedged API
      // server can't hang the request path.
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.status === 409) {
      return { accepted: false, duplicate: true, name };
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Job create failed: ${resp.status} ${text.slice(0, 200)}`);
    }
    return { accepted: true, name };
  };
}

module.exports = { createDispatcher, jobName, buildJob };
