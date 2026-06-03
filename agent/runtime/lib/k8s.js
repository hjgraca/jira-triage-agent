'use strict';

// Minimal in-cluster Kubernetes client — just enough to create one Job. Uses the
// pod's mounted ServiceAccount token + the in-cluster API host; zero deps.
//
// Returns { created } | { duplicate } from createJob: a 409 AlreadyExists means
// the deterministically-named Job already exists, i.e. a duplicate delivery —
// that IS our dedupe, no in-memory cache.

const fs = require('fs');

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const API = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT || '443'}`;

// Lazily read token + namespace so unit tests can run off-cluster without them.
// The API server's CA is trusted via NODE_EXTRA_CA_CERTS (set in the receiver
// Deployment to .../serviceaccount/ca.crt) — no per-request CA wiring needed.
function clusterAuth() {
  return {
    token: fs.readFileSync(`${SA}/token`, 'utf8').trim(),
    namespace: fs.readFileSync(`${SA}/namespace`, 'utf8').trim(),
  };
}

/**
 * Create a Job. On 409 (AlreadyExists) returns { duplicate: true } — used as the
 * dedupe signal. Any other non-2xx throws. `fetchImpl`/`auth` are injectable for
 * tests; default to global fetch + the in-cluster ServiceAccount.
 */
async function createJob(manifest, { fetchImpl = fetch, auth = clusterAuth } = {}) {
  const { token, namespace } = auth();
  const url = `${API}/apis/batch/v1/namespaces/${namespace}/jobs`;
  const resp = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  if (resp.status === 409) return { duplicate: true };
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`k8s createJob ${resp.status}: ${text.slice(0, 300)}`);
  }
  return { created: true };
}

module.exports = { createJob, clusterAuth };
