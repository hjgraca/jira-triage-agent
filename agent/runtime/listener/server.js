'use strict';

// Generic agent-runner HTTP server. It is NOT triage-specific: it authenticates
// and gates an inbound webhook (via a TRIGGER adapter), acks fast (KTD3), then
// spawns a one-shot coding-agent run (via a HARNESS adapter) whose PROMPT comes
// from the agent definition (the skill's SKILL.md frontmatter). Swap the skill
// (AGENT_PATH) → a different agent; swap TRIGGER → a different event source;
// swap HARNESS → a different coding CLI. This file is just the I/O shell + the
// per-run lifecycle invariants.

const http = require('http');
const { DedupeCache, SpawnLimiter } = require('./limits');
const { getAdapter } = require('../harness');
const { getTrigger } = require('../trigger');
const { loadAgentDef } = require('./agent-def');
const { createRunner } = require('./runner');

const PORT = parseInt(process.env.PORT || '8080', 10);
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/jira-webhook';
const HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET || '';
// Shared-secret bearer for callers that can't compute an HMAC (e.g. Jira Cloud
// Automation). Empty → only HMAC is accepted.
const AUTOMATION_SECRET = process.env.AUTOMATION_SHARED_SECRET || '';

// Resolve the three pluggable pieces once at load so a bad name fails fast:
//   TRIGGER  — how to authenticate/parse/gate the webhook (default jira)
//   HARNESS  — which coding-agent CLI to spawn (default pi)
//   AGENT_PATH (a.k.a. SKILL_PATH) — the skill dir whose SKILL.md frontmatter
//              IS the agent definition (its prompt drives what the agent does).
const { name: TRIGGER_NAME, trigger } = getTrigger(process.env.TRIGGER);
const { name: HARNESS_NAME, adapter: harness } = getAdapter(process.env.HARNESS);
const SKILL_PATH = process.env.AGENT_PATH || process.env.SKILL_PATH || '/agents/jira-triage';
const agentDef = loadAgentDef(SKILL_PATH);

// Model precedence: explicit env wins, else the agent definition, else default.
const RUN_MODEL =
  process.env.TRIAGE_MODEL || process.env.PI_MODEL || agentDef.model || 'us.anthropic.claude-sonnet-4-6';
// Watchdog ceiling for a single run; a child exceeding it is killed so it can't
// hold a limiter slot forever. (PI_TIMEOUT_MS kept as a back-compat alias.)
const RUN_TIMEOUT_MS = parseInt(
  process.env.TRIAGE_TIMEOUT_MS || process.env.PI_TIMEOUT_MS || '300000',
  10
);
// Authorized actors: env list ∪ the agent definition's own list. Either source
// can declare who may trigger; the trigger adapter enforces it.
const AUTHORIZED = new Set([
  ...(process.env.AUTHORIZED_ACTORS || '').split(',').map((s) => s.trim()).filter(Boolean),
  ...agentDef.authorizedActors,
]);

// Mutable listener state (loop guard, readiness).
const state = {
  botActor: null, // resolved at startup (e.g. Jira /myself) for the loop guard
  ready: false, // readiness gates on botActor (fail closed, R7)
  loopMarker: agentDef.loopMarker, // sentinel the agent writes; loop guard drops echoes
};

const dedupe = new DedupeCache();
const limiter = new SpawnLimiter({
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT || '3', 10),
  ceiling: parseInt(process.env.SPAWN_CEILING || '60', 10),
  dailyBudget: parseInt(process.env.DAILY_BUDGET || '500', 10),
});

// Log only structured, non-sensitive fields — never the raw payload or pi's
// full tool_execution output (log hygiene; ticket bodies carry PII).
function log(obj) {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n');
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

// Tracks live children so SIGTERM can signal them on shutdown.
const liveChildren = new Set();

// The per-run lifecycle (spawn → watchdog → release → classify) lives in
// runner.js; this shell only wires auth → gate → spawnRun.
const spawnRun = createRunner({
  harness,
  harnessName: HARNESS_NAME,
  agentDef,
  skillPath: SKILL_PATH,
  model: RUN_MODEL,
  limiter,
  dedupe,
  liveChildren,
  log,
  timeoutMs: RUN_TIMEOUT_MS,
});

// Pick a short human label for logs from the trigger's vars (e.g. the Jira key)
// without dumping the whole vars object (PII hygiene).
function labelFor(vars) {
  return vars.key || vars.id || vars.label || Object.values(vars)[0] || 'run';
}

async function handleWebhook(req, res, rawBody) {
  // 1. Authenticate via the trigger adapter (HMAC over the raw body, or a
  //    shared-secret bearer for callers that can't sign). Constant-time; the IP
  //    origin lock (R10b) is the outer fence in front of both.
  const authResult = trigger.authenticate(req.headers, rawBody, {
    hmac: HMAC_SECRET,
    sharedSecret: AUTOMATION_SECRET,
  });
  if (!authResult.ok) {
    log({ msg: 'reject', reason: 'unauthenticated' });
    res.writeHead(401).end('unauthorized');
    return;
  }

  // 2. Parse (after auth, so we never parse untrusted unsigned bodies)
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    log({ msg: 'reject', reason: 'bad-json' });
    res.writeHead(400).end('bad request');
    return;
  }

  // 3. Dedupe (R8) on the trigger-supplied delivery id.
  const id = trigger.dedupeId(req.headers, payload);
  if (dedupe.seenBefore(id)) {
    log({ msg: 'drop', reason: 'duplicate', id });
    res.writeHead(200).end('ok');
    return;
  }

  // 4. Gate via the trigger adapter: loop-guard → eligibility → authorization.
  //    The agent definition supplies the authz allowlist + loop marker.
  const verdict = trigger.decide(payload, agentDef, {
    botActor: state.botActor,
    loopMarker: state.loopMarker,
    authorizedActors: AUTHORIZED,
  });
  if (verdict.action === 'drop') {
    log({ msg: 'drop', reason: verdict.reason });
    res.writeHead(200).end('ok');
    return;
  }

  const vars = verdict.vars || {};
  const label = labelFor(vars);

  // 5. Spawn limiter (R10c) — drop with logged 200 when full
  const slot = limiter.tryAcquire();
  if (!slot.ok) {
    log({ msg: 'drop', reason: `limiter:${slot.reason}`, label });
    res.writeHead(200).end('ok');
    return;
  }

  // 6. Ack fast, then spawn off the request path (KTD3). Pass the dedupe id so a
  // spawn failure can evict it and let redelivery retry (otherwise the id is
  // cached for 24h and the eligible event is silently never run).
  log({ msg: 'spawn', label, authVia: authResult.via, trigger: TRIGGER_NAME, agent: agentDef.name });
  res.writeHead(200).end('ok');
  spawnRun(vars, id, label);
}

function createServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      // Liveness: process is up.
      res.writeHead(200).end('ok');
      return;
    }
    if (req.method === 'GET' && req.url === '/readyz') {
      // Readiness gates on a resolved bot accountId (fail closed, R7): without
      // it the loop guard is blind, so we must not serve webhooks.
      res.writeHead(state.ready ? 200 : 503).end(state.ready ? 'ready' : 'not-ready');
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

// Resolve the bot actor id for the loop guard before flipping ready (fail
// closed). This is trigger-specific: the Jira trigger resolves it via GET
// /myself; a trigger with no notion of a "bot actor" (e.g. generic) has nothing
// to resolve and is ready immediately. Returns null when not applicable.
async function resolveBotActor() {
  if (TRIGGER_NAME !== 'jira') return null; // no bot-actor concept for this trigger
  const base = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (!base || !email || !token) throw new Error('JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN required');
  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  // Bound the call: Node fetch has no default timeout, so a hung Jira
  // connection would block startup and every retry tick forever.
  const resp = await fetch(`${base.replace(/\/$/, '')}/rest/api/3/myself`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`/myself failed: ${resp.status}`);
  const me = await resp.json();
  if (!me.accountId) throw new Error('/myself returned no accountId');
  return me.accountId;
}

// Self-rescheduling probe (not setInterval) so at most one call is in flight —
// during an outage an awaited setInterval callback would stack overlapping
// requests.
function scheduleReadinessProbe() {
  if (state.ready) return;
  const t = setTimeout(async () => {
    try {
      state.botActor = await resolveBotActor();
      state.ready = true;
      log({ msg: 'ready', botActor: state.botActor });
    } catch (e) {
      log({ msg: 'startup_bot_actor_retry_failed', error: e.message });
      scheduleReadinessProbe();
    }
  }, 15 * 1000);
  t.unref();
}

function installShutdownHandler(server) {
  let shuttingDown = false;
  const onSignal = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log({ msg: 'shutdown', signal: sig, inFlight: liveChildren.size });
    state.ready = false; // stop accepting new webhooks (readiness 503)
    server.close();
    // Give in-flight triage runs a bounded grace, then signal them so they
    // aren't hard-killed mid-write by the runtime.
    const grace = setTimeout(() => {
      for (const child of liveChildren) child.kill('SIGTERM');
      process.exit(0);
    }, 25_000);
    grace.unref();
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
}

async function start() {
  const server = createServer();
  server.listen(PORT, () =>
    log({
      msg: 'listening',
      port: PORT,
      path: WEBHOOK_PATH,
      trigger: TRIGGER_NAME,
      harness: HARNESS_NAME,
      agent: agentDef.name,
    })
  );
  setInterval(() => dedupe.sweep(), 60 * 60 * 1000).unref();
  installShutdownHandler(server);

  // Block readiness until the loop guard has its bot actor (when the trigger has
  // one). A trigger with no bot-actor concept resolves null and is ready at once.
  try {
    state.botActor = await resolveBotActor();
    state.ready = true;
    log({ msg: 'ready', botActor: state.botActor });
  } catch (err) {
    log({ msg: 'startup_bot_actor_failed', error: err.message });
    // Stay not-ready; retry in the background so a transient outage recovers
    // without a manual restart.
    scheduleReadinessProbe();
  }
  return server;
}

if (require.main === module) start();

module.exports = { createServer, state, dedupe, limiter };
