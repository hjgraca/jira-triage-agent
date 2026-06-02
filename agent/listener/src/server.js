'use strict';

// Webhook listener HTTP server. Validates and gates inbound Jira webhooks, acks
// fast (KTD3), then spawns a one-shot `pi --mode json` triage run off the
// request path. Pure decision logic lives in gate.js / limits.js; this file is
// the I/O shell.

const http = require('http');
const { spawn } = require('child_process');
const { verifySignature, verifySharedSecret, decide, TRIAGE_MARKER } = require('./gate');
const { DedupeCache, SpawnLimiter } = require('./limits');
const { getAdapter } = require('./harness');

const PORT = parseInt(process.env.PORT || '8080', 10);
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/jira-webhook';
const HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET || '';
// Shared-secret bearer for the Jira Automation path (the rule can't compute an
// HMAC). Empty → that path is disabled and only HMAC is accepted.
const AUTOMATION_SECRET = process.env.AUTOMATION_SHARED_SECRET || '';
const AUTOMATION_TOKEN_HEADER = 'x-triage-token';
// Which coding-agent harness to spawn per webhook (pi, kiro-cli, …). The
// adapter owns the argv + output handling; resolved once at load so a bad
// HARNESS fails fast. See src/harness/README.md.
const { name: HARNESS_NAME, adapter: harness } = getAdapter(process.env.HARNESS);
const TRIAGE_MODEL =
  process.env.TRIAGE_MODEL || process.env.PI_MODEL || 'us.anthropic.claude-sonnet-4-6';
const SKILL_PATH = process.env.SKILL_PATH || '/skills/jira-triage';
// Watchdog ceiling for a single triage run; a child exceeding it is killed so
// it can't hold a limiter slot forever. TRIAGE_TIMEOUT_MS is harness-neutral;
// PI_TIMEOUT_MS is kept as a back-compat alias.
const TRIAGE_TIMEOUT_MS = parseInt(
  process.env.TRIAGE_TIMEOUT_MS || process.env.PI_TIMEOUT_MS || '300000',
  10
);
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
  // One-shot run via the active harness adapter. The adapter owns the argv and
  // (for streaming harnesses) the stdout parsing; this shell owns the lifecycle
  // (limiter slot, watchdog, dedupe-evict on spawn failure) so those invariants
  // hold no matter which harness is plugged in.
  const prompt = `Triage Jira issue ${key} using the jira-triage skill. Act on exactly this one ticket, then stop.`;
  const cmd = harness.buildCommand({ key, skillPath: SKILL_PATH, model: TRIAGE_MODEL, prompt });
  const child = spawn(cmd.bin, cmd.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Merge any adapter-declared env onto the inherited process env (IRSA vars,
    // KIRO_API_KEY, etc. are already in process.env from the pod spec).
    env: cmd.env ? { ...process.env, ...cmd.env } : process.env,
  });
  liveChildren.add(child);

  // Per-run accumulator the adapter mutates via interpret()/reads in finalize().
  const runState = {};

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

  // Watchdog: a hung run (model slow/unreachable, harness stuck) emits neither
  // 'close' nor 'error', so without this the slot leaks forever and enough
  // stuck runs silently wedge all triage. SIGTERM then SIGKILL after a grace.
  const watchdog = setTimeout(() => {
    log({ msg: 'triage_timeout', key, harness: HARNESS_NAME, timeoutMs: TRIAGE_TIMEOUT_MS });
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
  }, TRIAGE_TIMEOUT_MS);
  watchdog.unref();

  // Streaming harnesses parse stdout line-by-line; non-streaming ones omit
  // interpret() and are classified from the exit code in finalize(). Never log
  // full payloads (ticket bodies carry PII).
  if (typeof harness.interpret === 'function') {
    child.stdout.on('data', (buf) => {
      for (const line of buf.toString().split('\n')) harness.interpret(line, runState);
    });
  }
  child.on('close', (code) => {
    releaseOnce();
    // Streaming harnesses can report a clean terminal event (e.g. pi's
    // agent_end); log it for parity with the pre-adapter behavior.
    if (runState.agentEnded) log({ msg: 'triage_done', key, harness: HARNESS_NAME });
    const { toolError } = harness.finalize(code, runState);
    log({ msg: 'triage_exit', key, harness: HARNESS_NAME, code, toolError });
  });
  child.on('error', (err) => {
    releaseOnce();
    // The run never happened — let Jira's redelivery of this identifier retry.
    dedupe.evict(dedupeId);
    log({ msg: 'triage_spawn_error', key, harness: HARNESS_NAME, error: err.message });
  });
}

async function handleWebhook(req, res, rawBody) {
  // 1. Authenticate: EITHER a valid HMAC over the raw body (system webhook,
  //    R10/R10a) OR a valid shared-secret bearer (Jira Automation path, which
  //    cannot sign — R10a-bis). Both are constant-time; the IP origin lock
  //    (R10b) is the outer fence in front of both.
  const hmacOk = verifySignature(rawBody, req.headers['x-hub-signature'], HMAC_SECRET);
  const tokenOk =
    !!AUTOMATION_SECRET &&
    verifySharedSecret(req.headers[AUTOMATION_TOKEN_HEADER], AUTOMATION_SECRET);
  if (!hmacOk && !tokenOk) {
    log({ msg: 'reject', reason: 'unauthenticated' });
    res.writeHead(401).end('unauthorized');
    return;
  }
  const authVia = hmacOk ? 'hmac' : 'shared-secret';

  // 2. Parse (after auth, so we never parse untrusted unsigned bodies)
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    log({ msg: 'reject', reason: 'bad-json' });
    res.writeHead(400).end('bad request');
    return;
  }

  // 3. Dedupe (R8). System webhooks carry Jira's native identifier; the
  //    Automation rule has no such header, so it sends its own stable id in
  //    X-Triage-Delivery-Id (e.g. {{automationRule.id}}-{{issue.key}}-{{...}}).
  const id =
    req.headers['x-atlassian-webhook-identifier'] || req.headers['x-triage-delivery-id'];
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
  log({ msg: 'spawn', key: verdict.key, authVia });
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
  server.listen(PORT, () =>
    log({ msg: 'listening', port: PORT, path: WEBHOOK_PATH, harness: HARNESS_NAME })
  );
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
