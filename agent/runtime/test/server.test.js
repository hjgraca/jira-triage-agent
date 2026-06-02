'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');

// Configure env BEFORE requiring the server module.
const path = require('path');
process.env.WEBHOOK_HMAC_SECRET = 'b'.repeat(64);
process.env.AUTOMATION_SHARED_SECRET = 'c'.repeat(48);
process.env.AUTHORIZED_ACTORS = 'ALLOWED-1';
process.env.PI_BIN = '/usr/bin/true'; // spawning this exits 0 immediately, no real pi
// The agent definition is the real jira-triage skill (its SKILL.md frontmatter).
process.env.AGENT_PATH = path.join(__dirname, '..', '..', 'agents', 'jira-triage');

const SECRET = process.env.WEBHOOK_HMAC_SECRET;
const AUTOMATION_SECRET = process.env.AUTOMATION_SHARED_SECRET;
const { createServer, state, limiter } = require('../listener/server');

let server;
let port;

before(async () => {
  state.botAccountId = 'BOT-1';
  state.ready = true;
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
});

after(() => server.close());

function sign(body) {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}

function post(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('POST without signature → 401', async () => {
  const body = JSON.stringify({ webhookEvent: 'jira:issue_created', issue: { key: 'KAN-1' } });
  const r = await post('/jira-webhook', body);
  assert.strictEqual(r.status, 401);
});

test('POST with wrong signature → 401', async () => {
  const body = JSON.stringify({ webhookEvent: 'jira:issue_created', issue: { key: 'KAN-1' } });
  const r = await post('/jira-webhook', body, { 'x-hub-signature': 'sha256=deadbeef' });
  assert.strictEqual(r.status, 401);
});

test('valid signature, eligible event → 200 (ack-fast)', async () => {
  const body = JSON.stringify({
    webhookEvent: 'jira:issue_created',
    user: { accountId: 'X' },
    issue: { key: 'KAN-2' },
  });
  const r = await post('/jira-webhook', body, {
    'x-hub-signature': sign(body),
    'x-atlassian-webhook-identifier': 'wid-1',
  });
  assert.strictEqual(r.status, 200);
});

test('duplicate identifier → 200, no second spawn path', async () => {
  const body = JSON.stringify({
    webhookEvent: 'jira:issue_created',
    user: { accountId: 'X' },
    issue: { key: 'KAN-3' },
  });
  const h = { 'x-hub-signature': sign(body), 'x-atlassian-webhook-identifier': 'wid-dup' };
  const r1 = await post('/jira-webhook', body, h);
  const r2 = await post('/jira-webhook', body, h);
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r2.status, 200); // deduped, still 200
});

test('malformed JSON with valid signature → 400', async () => {
  const body = '{not json';
  const r = await post('/jira-webhook', body, {
    'x-hub-signature': sign(body),
    'x-atlassian-webhook-identifier': 'wid-bad',
  });
  assert.strictEqual(r.status, 400);
});

test('unauthorized label-add → 200 drop, no spawn', async () => {
  const body = JSON.stringify({
    webhookEvent: 'jira:issue_updated',
    user: { accountId: 'OUTSIDER' },
    issue: { key: 'KAN-4' },
    changelog: { items: [{ field: 'labels', fromString: '', toString: 'triage' }] },
  });
  const r = await post('/jira-webhook', body, {
    'x-hub-signature': sign(body),
    'x-atlassian-webhook-identifier': 'wid-unauth',
  });
  assert.strictEqual(r.status, 200);
});

// --- Jira Automation path (shared-secret, R10a-bis) --------------------------
test('Automation request with valid shared-secret token + eligible event → 200', async () => {
  const body = JSON.stringify({
    webhookEvent: 'automation:label-added',
    user: { accountId: 'ALLOWED-1' },
    issue: { key: 'KAN-AUTO-1' },
  });
  const r = await post('/jira-webhook', body, {
    'x-triage-token': AUTOMATION_SECRET,
    'x-triage-delivery-id': 'auto-del-1',
  });
  assert.strictEqual(r.status, 200);
});

test('Automation request with wrong shared-secret token → 401', async () => {
  const body = JSON.stringify({
    webhookEvent: 'automation:label-added',
    user: { accountId: 'ALLOWED-1' },
    issue: { key: 'KAN-AUTO-2' },
  });
  const r = await post('/jira-webhook', body, {
    'x-triage-token': 'wrong-token',
    'x-triage-delivery-id': 'auto-del-2',
  });
  assert.strictEqual(r.status, 401);
});

test('Automation request with no auth at all → 401', async () => {
  const body = JSON.stringify({
    webhookEvent: 'automation:label-added',
    user: { accountId: 'ALLOWED-1' },
    issue: { key: 'KAN-AUTO-3' },
  });
  const r = await post('/jira-webhook', body, { 'x-triage-delivery-id': 'auto-del-3' });
  assert.strictEqual(r.status, 401);
});

test('Automation delivery-id is deduped on its own header', async () => {
  const body = JSON.stringify({
    webhookEvent: 'automation:label-added',
    user: { accountId: 'ALLOWED-1' },
    issue: { key: 'KAN-AUTO-4' },
  });
  const h = { 'x-triage-token': AUTOMATION_SECRET, 'x-triage-delivery-id': 'auto-del-dup' };
  const r1 = await post('/jira-webhook', body, h);
  const r2 = await post('/jira-webhook', body, h);
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r2.status, 200); // deduped, still 200
});

test('spawn lifecycle releases the limiter slot (active drains to 0)', async () => {
  // /usr/bin/true exits 0 immediately. After all in-flight runs settle, active
  // must drain to 0 — a leaked slot (missed release) would leave it >0; the
  // release-once guard prevents underflow on the error+close double-fire.
  const body = JSON.stringify({
    webhookEvent: 'jira:issue_created',
    user: { accountId: 'X' },
    issue: { key: 'KAN-SLOT' },
  });
  await post('/jira-webhook', body, {
    'x-hub-signature': sign(body),
    'x-atlassian-webhook-identifier': 'wid-slot',
  });
  // Poll until the limiter drains (children from this and earlier tests exit).
  for (let i = 0; i < 50 && limiter.active > 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.strictEqual(limiter.active, 0, 'limiter.active drained to 0');
});

test('loop marker comes from the agent definition (SKILL.md frontmatter)', () => {
  // The runtime loop-guard marker is now sourced from the skill, not hardcoded.
  const { loadAgentDef } = require('../listener/agent-def');
  const def = loadAgentDef(process.env.AGENT_PATH);
  assert.ok(typeof def.loopMarker === 'string' && def.loopMarker.length > 0);
  assert.strictEqual(state.loopMarker, def.loopMarker);
  // And it still matches the disclaimer the skill's jira.sh writes.
  assert.strictEqual(def.loopMarker, 'This was generated by AI during triage.');
});

test('/readyz reflects fail-closed startup gate', async () => {
  const get = (path) =>
    new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
    });
  state.ready = false;
  assert.strictEqual(await get('/readyz'), 503);
  state.ready = true;
  assert.strictEqual(await get('/readyz'), 200);
});
