'use strict';

// Webhook listener HTTP server. Validates and gates inbound Jira webhooks, acks
// fast (KTD3), then spawns a one-shot `pi --mode json` triage run off the
// request path. Pure decision logic lives in gate.js / limits.js; this file is
// the I/O shell.

const http = require('http');
const { spawn } = require('child_process');
const { verifySignature, decide, TRIAGE_MARKER } = require('./gate');
const { DedupeCache, SpawnLimiter } = require('./limits');

const PORT = parseInt(process.env.PORT || '8080', 10);
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/jira-webhook';
const HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET || '';
const PI_BIN = process.env.PI_BIN || 'pi';
const PI_MODEL = process.env.PI_MODEL || 'us.anthropic.claude-sonnet-4-20250514-v1:0';
const SKILL_PATH = process.env.SKILL_PATH || '/skills/jira-triage';
// Watchdog ceiling for a single triage run; a child exceeding it is killed so
// it can't hold a limiter slot forever.
const PI_TIMEOUT_MS = parseInt(process.env.PI_TIMEOUT_MS || '300000', 10);
const AUTHORIZED = new Set(
  (process.env.AUTHORIZED_ACTORS || '').split(',').map((s) => s.trim()).filter(Boolean)
);

// Mutable listener state (R7 loop guard, readiness).
const state = {
  botAccountId: null, // resolved at startup via GET /myself
  ready: false, // readiness gates on botAccountId (fail closed, R7)
  authorizedActors: AUTHORIZED,
  triageMarker: TRIAGE_MARKER,
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

function spawnTriage(key, dedupeId) {
  // Each run is one-shot: pi --mode json --skill <path> "<prompt>" then exit.
  const prompt = `Triage Jira issue ${key} using the jira-triage skill. Act on exactly this one ticket, then stop.`;
  const child = spawn(
    PI_BIN,
    ['--mode', 'json', '--provider', 'amazon-bedrock', '--model', PI_MODEL, '--skill', SKILL_PATH, prompt],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  liveChildren.add(child);

  // Release the limiter slot EXACTLY once: a failed spawn emits both 'error'
  // and 'close', so guarding with a flag prevents a double-release that would
  // corrupt the concurrency count and defeat the R10c storm/loop defense.
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    clearTimeout(watchdog);
    liveChildren.delete(child);
    limiter.release();
  };

  // Watchdog: a hung run (Bedrock slow/unreachable, pi stuck) emits neither
  // 'close' nor 'error', so without this the slot leaks forever and enough
  // stuck runs silently wedge all triage. SIGTERM then SIGKILL after a grace.
  const watchdog = setTimeout(() => {
    log({ msg: 'triage_timeout', key, timeoutMs: PI_TIMEOUT_MS });
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
  }, PI_TIMEOUT_MS);
  watchdog.unref();

  let lastErr = false;
  child.stdout.on('data', (buf) => {
    // Watch for terminal/error events; do NOT log full payloads.
    for (const line of buf.toString().split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'tool_execution_end' && ev.isError) lastErr = true;
        if (ev.type === 'agent_end') log({ msg: 'triage_done', key });
      } catch {
        /* partial line; ignore */
      }
    }
  });
  child.on('close', (code) => {
    releaseOnce();
    log({ msg: 'triage_exit', key, code, toolError: lastErr });
  });
  child.on('error', (err) => {
    releaseOnce();
    // The run never happened — let Jira's redelivery of this identifier retry.
    dedupe.evict(dedupeId);
    log({ msg: 'triage_spawn_error', key, error: err.message });
  });
}

async function handleWebhook(req, res, rawBody) {
  // 1. HMAC (R10/R10a)
  if (!verifySignature(rawBody, req.headers['x-hub-signature'], HMAC_SECRET)) {
    log({ msg: 'reject', reason: 'bad-signature' });
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

  // 3. Dedupe (R8)
  const id = req.headers['x-atlassian-webhook-identifier'];
  if (dedupe.seenBefore(id)) {
    log({ msg: 'drop', reason: 'duplicate', id });
    res.writeHead(200).end('ok');
    return;
  }

  // 4. Gate: loop-guard → eligibility → authorization (gate.decide)
  const verdict = decide(payload, state);
  if (verdict.action === 'drop') {
    log({ msg: 'drop', reason: verdict.reason });
    res.writeHead(200).end('ok');
    return;
  }

  // 5. Spawn limiter (R10c) — drop with logged 200 when full
  const slot = limiter.tryAcquire();
  if (!slot.ok) {
    log({ msg: 'drop', reason: `limiter:${slot.reason}`, key: verdict.key });
    res.writeHead(200).end('ok');
    return;
  }

  // 6. Ack fast, then spawn off the request path (KTD3). Pass the dedupe id so
  // a spawn failure can evict it and let Jira's redelivery retry (otherwise the
  // id is cached for 24h and the eligible ticket is silently never triaged).
  log({ msg: 'spawn', key: verdict.key });
  res.writeHead(200).end('ok');
  spawnTriage(verdict.key, id);
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

// Resolve the bot accountId via GET /myself before flipping ready (fail closed).
async function resolveBotAccountId() {
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

// Self-rescheduling probe (not setInterval) so at most one /myself call is in
// flight — during a Jira outage an awaited setInterval callback would stack
// overlapping requests.
function scheduleReadinessProbe() {
  if (state.ready) return;
  const t = setTimeout(async () => {
    try {
      state.botAccountId = await resolveBotAccountId();
      state.ready = true;
      log({ msg: 'ready', botAccountId: state.botAccountId });
    } catch (e) {
      log({ msg: 'startup_myself_retry_failed', error: e.message });
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
  server.listen(PORT, () => log({ msg: 'listening', port: PORT, path: WEBHOOK_PATH }));
  setInterval(() => dedupe.sweep(), 60 * 60 * 1000).unref();
  installShutdownHandler(server);

  // Block readiness until the loop guard has its bot accountId.
  try {
    state.botAccountId = await resolveBotAccountId();
    state.ready = true;
    log({ msg: 'ready', botAccountId: state.botAccountId });
  } catch (err) {
    log({ msg: 'startup_myself_failed', error: err.message });
    // Stay not-ready; retry in the background so a transient Jira outage
    // recovers without a manual restart.
    scheduleReadinessProbe();
  }
  return server;
}

if (require.main === module) start();

module.exports = { createServer, state, dedupe, limiter };
