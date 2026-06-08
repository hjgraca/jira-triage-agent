'use strict';

// Stateless webhook receiver. Authenticates + gates an inbound event, then
// creates ONE Kubernetes Job to run it — and acks. That's all. No long-lived
// state: dedupe is the Job's deterministic name (409 = duplicate), concurrency
// is a namespace ResourceQuota, the per-run timeout is the Job's
// activeDeadlineSeconds. So this can run with N replicas, and a restart loses
// nothing.
//
// It runs the SAME agent image as the Jobs it creates (just a different command),
// so the gate here reads the exact SKILL.md the run will use — no config drift.

const http = require('http');
const { getTrigger } = require('./trigger');
const { loadAgentDef } = require('./lib/agent-def');
const { buildJob, jobName } = require('./lib/job');
const k8s = require('./lib/k8s');

// Indirection so tests can stub Job creation without an in-cluster API.
let jobCreator = k8s.createJob;
function setJobCreator(fn) {
  jobCreator = fn;
}

const PORT = parseInt(process.env.PORT || '8080', 10);
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhook';
const HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET || '';
const SHARED_SECRET = process.env.SHARED_SECRET || process.env.AUTOMATION_SHARED_SECRET || '';
const AGENT_PATH = process.env.AGENT_PATH || '/agent';
// The image this receiver stamps into the Jobs it creates — normally its own.
const AGENT_IMAGE = process.env.AGENT_IMAGE;
// NON-secret literal env for each run Job (e.g. "HARNESS=pi,MODEL=...").
const RUN_ENV = parseEnvList(process.env.RUN_ENV);
// The run Job loads creds itself from these (envFrom) — the receiver never
// touches secret values. Empty → no envFrom.
const RUN_SECRET = process.env.RUN_SECRET || '';
const RUN_CONFIGMAP = process.env.RUN_CONFIGMAP || '';

const { name: TRIGGER_NAME, trigger } = getTrigger(process.env.TRIGGER);
const agentDef = loadAgentDef(AGENT_PATH);
// Authorized actors: env list ∪ the agent definition's own list.
const authorizedActors = new Set([
  ...(process.env.AUTHORIZED_ACTORS || '').split(',').map((s) => s.trim()).filter(Boolean),
  ...agentDef.authorizedActors,
]);
const gateDef = { ...agentDef, authorizedActors };

function log(obj) {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n');
}

function parseEnvList(s) {
  // "NAME=VALUE,NAME2=VALUE2" → [{name, value}], for the Job's container env.
  return String(s || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=');
      return { name: i === -1 ? p : p.slice(0, i), value: i === -1 ? '' : p.slice(i + 1) };
    });
}

function readRawBody(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function labelFor(vars) {
  return vars.key || vars.id || vars.label || Object.values(vars)[0] || 'run';
}

async function handleWebhook(req, res, rawBody) {
  // 1. Authenticate via the trigger adapter (constant-time HMAC or shared secret).
  const auth = trigger.authenticate(req.headers, rawBody, { hmac: HMAC_SECRET, sharedSecret: SHARED_SECRET });
  if (!auth.ok) {
    log({ msg: 'reject', reason: 'unauthenticated' });
    return res.writeHead(401).end('unauthorized');
  }
  // Which proof satisfied auth ('hmac' | 'shared-secret') — surfaced on the spawn
  // log so operators can confirm which trigger path is live (see DC Jira setup).
  const authVia = auth.via;

  // 2. Parse (only after auth).
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    log({ msg: 'reject', reason: 'bad-json' });
    return res.writeHead(400).end('bad request');
  }

  // 3. Gate: loop-guard → eligibility → authorization (all in the trigger).
  const verdict = trigger.decide(payload, gateDef);
  if (verdict.action === 'drop') {
    log({ msg: 'drop', reason: verdict.reason });
    return res.writeHead(200).end('ok');
  }

  const vars = verdict.vars || {};
  const label = labelFor(vars);
  const id = trigger.dedupeId(req.headers, payload) || label;

  // 4. Create one Job (named from the dedupe id → 409 = duplicate). Ack 200
  //    either way so the trigger doesn't retry a deliberate drop/dup forever.
  const name = jobName(agentDef.name, id);
  const manifest = buildJob({
    name,
    image: AGENT_IMAGE,
    vars,
    env: RUN_ENV,
    secretName: RUN_SECRET || undefined,
    configMapName: RUN_CONFIGMAP || undefined,
  });
  try {
    const r = await jobCreator(manifest);
    log({ msg: r.duplicate ? 'duplicate' : 'spawn', label, name, trigger: TRIGGER_NAME, authVia, agent: agentDef.name });
    res.writeHead(200).end('ok');
  } catch (err) {
    // A real API failure — let the trigger retry (5xx).
    log({ msg: 'error', reason: 'job-create-failed', error: err.message, label });
    res.writeHead(502).end('job create failed');
  }
}

function createServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/readyz')) {
      return res.writeHead(200).end('ok'); // stateless: ready as soon as it's up
    }
    if (req.method === 'POST' && req.url === WEBHOOK_PATH) {
      readRawBody(req)
        .then((body) => handleWebhook(req, res, body))
        .catch((err) => {
          log({ msg: 'reject', reason: 'read-error', error: err.message });
          if (!res.headersSent) res.writeHead(400).end('bad request');
        });
      return;
    }
    res.writeHead(404).end('not found');
  });
}

if (require.main === module) {
  if (!AGENT_IMAGE) {
    log({ msg: 'fatal', reason: 'AGENT_IMAGE env is required (the image to run per event)' });
    process.exit(1);
  }
  createServer().listen(PORT, () =>
    log({ msg: 'listening', port: PORT, path: WEBHOOK_PATH, trigger: TRIGGER_NAME, agent: agentDef.name })
  );
}

module.exports = { createServer, handleWebhook, parseEnvList, setJobCreator };
