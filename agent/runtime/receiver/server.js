'use strict';

// Receiver: a thin, STATELESS HTTP front door. Per request it does only:
//   authenticate (trigger) → parse → gate (trigger.decide) → dispatch one run.
// It holds NO per-event state — no dedupe cache, no concurrency semaphore, no
// daily counter, no bot-identity HTTP call. Those belong to the dispatcher:
//   - k8s-job: Kubernetes provides dedupe (deterministic Job name → 409) and
//     concurrency (ResourceQuota). The receiver can run N replicas.
//   - exec:    the exec dispatcher holds them in-memory (dev/workshop only).
//
// It is also AGNOSTIC: it knows nothing about Jira, pi, or triage. The TRIGGER
// adapter owns event-source specifics, the AGENT (a skill's SKILL.md) owns what
// the agent does, the HARNESS owns the CLI, the DISPATCH owns how a run starts.

const http = require('http');
const { getTrigger } = require('../trigger');
const { getDispatcherFactory } = require('../dispatch');
const { loadAgentDef } = require('../lib/agent-def');

const PORT = parseInt(process.env.PORT || '8080', 10);
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhook';
const HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET || '';
const SHARED_SECRET = process.env.WEBHOOK_SHARED_SECRET || process.env.AUTOMATION_SHARED_SECRET || '';

// The four pluggable axes, resolved once so a bad name fails fast at startup.
const { name: TRIGGER_NAME, trigger } = getTrigger(process.env.TRIGGER);
const { name: DISPATCH_NAME, createDispatcher } = getDispatcherFactory(process.env.DISPATCH);
const AGENT_PATH = process.env.AGENT_PATH || process.env.SKILL_PATH || '/agents/agent';
const HARNESS = process.env.HARNESS || 'pi';
const MODEL = process.env.MODEL || '';
const agentDef = loadAgentDef(AGENT_PATH);

// Authorized actors: env list ∪ the agent definition's own list. The trigger
// enforces it; the receiver just supplies it.
const AUTHORIZED = new Set([
  ...(process.env.AUTHORIZED_ACTORS || '').split(',').map((s) => s.trim()).filter(Boolean),
  ...agentDef.authorizedActors,
]);

function log(obj) {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n');
}

// When the exec dispatcher is in use it spawns child processes; it hands us its
// live-set via registerLive so SIGTERM can signal them on shutdown. (k8s-job
// dispatch spawns nothing in this process, so this stays empty.)
let liveChildren = new Set();

const dispatch = createDispatcher({
  log,
  registerLive: (set) => { liveChildren = set; }, // exec passes its own Set
  // exec-mode limits (ignored by k8s-job, which uses ResourceQuota instead):
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT || '3', 10),
  ceiling: parseInt(process.env.SPAWN_CEILING || '60', 10),
  dailyBudget: parseInt(process.env.DAILY_BUDGET || '500', 10),
  // k8s-job config (ignored by exec):
  image: process.env.RUN_IMAGE,
  namePrefix: process.env.RUN_NAME_PREFIX || 'agent-run',
  managedBy: 'agent-runner',
  runnerServiceAccount: process.env.RUN_SERVICE_ACCOUNT || 'agent-runner',
  backoffLimit: parseInt(process.env.RUN_BACKOFF_LIMIT || '1', 10),
  ttlSeconds: parseInt(process.env.RUN_TTL_SECONDS || '3600', 10),
  activeDeadlineSeconds: parseInt(process.env.RUN_TIMEOUT_MS || '300000', 10) / 1000,
  resources: {
    requests: { cpu: '100m', memory: '256Mi' },
    limits: { memory: process.env.RUN_MEMORY_LIMIT || '2Gi' },
  },
  envFrom: process.env.RUN_ENV_FROM_SECRET
    ? [{ secretRef: { name: process.env.RUN_ENV_FROM_SECRET } }]
    : undefined,
  // Optional ConfigMap mount for the agent's allowed-value config (the skill
  // reads it at TRIAGE_CONFIG). Set RUN_CONFIG_MAP to enable.
  volumes: process.env.RUN_CONFIG_MAP
    ? [{ name: 'agent-config', configMap: { name: process.env.RUN_CONFIG_MAP } }]
    : undefined,
  volumeMounts: process.env.RUN_CONFIG_MAP
    ? [{ name: 'agent-config', mountPath: process.env.RUN_CONFIG_MOUNT || '/etc/agent', readOnly: true }]
    : undefined,
});

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
  // 1. Authenticate (trigger): HMAC over the raw body, or a shared-secret bearer.
  const authResult = trigger.authenticate(req.headers, rawBody, {
    hmac: HMAC_SECRET,
    sharedSecret: SHARED_SECRET,
  });
  if (!authResult.ok) {
    log({ msg: 'reject', reason: 'unauthenticated' });
    res.writeHead(401).end('unauthorized');
    return;
  }

  // 2. Parse (only after auth — never parse untrusted unsigned bodies).
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    log({ msg: 'reject', reason: 'bad-json' });
    res.writeHead(400).end('bad request');
    return;
  }

  // 3. Gate (trigger): loop-guard → eligibility → authorization. The agent
  //    definition supplies the authz allowlist + loop marker.
  const verdict = trigger.decide(payload, agentDef, {
    loopMarker: agentDef.loopMarker,
    authorizedActors: AUTHORIZED,
  });
  if (verdict.action === 'drop') {
    log({ msg: 'drop', reason: verdict.reason });
    res.writeHead(200).end('ok');
    return;
  }

  const vars = verdict.vars || {};
  const label = labelFor(vars);
  const dedupeId = trigger.dedupeId(req.headers, payload);

  // 4. Dispatch one run, then ack. Dedupe + concurrency live in the dispatcher.
  let result;
  try {
    result = await dispatch({ vars, dedupeId, label, agentPath: AGENT_PATH, harness: HARNESS, model: MODEL });
  } catch (err) {
    log({ msg: 'dispatch_error', label, error: err.message });
    res.writeHead(502).end('dispatch failed'); // let the sender retry
    return;
  }

  if (result.duplicate) {
    log({ msg: 'drop', reason: 'duplicate', label });
  } else if (result.accepted === false) {
    log({ msg: 'drop', reason: `limited:${result.limited || 'unknown'}`, label });
  } else {
    log({ msg: 'dispatched', label, trigger: TRIGGER_NAME, dispatch: DISPATCH_NAME, agent: agentDef.name, authVia: authResult.via });
  }
  res.writeHead(200).end('ok'); // ack either way (idempotent from the sender's view)
}

function createServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200).end('ok');
      return;
    }
    if (req.method === 'GET' && req.url === '/readyz') {
      // Stateless receiver: ready as soon as it's listening (no bot-identity
      // resolution to wait on — that Jira-ism is gone from the engine).
      res.writeHead(200).end('ready');
      return;
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

function installShutdownHandler(server) {
  let shuttingDown = false;
  const onSignal = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log({ msg: 'shutdown', signal: sig, inFlight: liveChildren.size });
    server.close();
    const grace = setTimeout(() => {
      for (const child of liveChildren) child.kill('SIGTERM');
      process.exit(0);
    }, 25_000);
    grace.unref();
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
}

function start() {
  const server = createServer();
  server.listen(PORT, () =>
    log({
      msg: 'listening',
      port: PORT,
      path: WEBHOOK_PATH,
      trigger: TRIGGER_NAME,
      dispatch: DISPATCH_NAME,
      harness: HARNESS,
      agent: agentDef.name,
    })
  );
  installShutdownHandler(server);
  return server;
}

if (require.main === module) start();

module.exports = { createServer };
