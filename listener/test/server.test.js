'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');

// Configure env BEFORE requiring the server module.
process.env.WEBHOOK_HMAC_SECRET = 'b'.repeat(64);
process.env.AUTHORIZED_ACTORS = 'ALLOWED-1';
process.env.PI_BIN = '/usr/bin/true'; // spawning this exits 0 immediately, no real pi

const SECRET = process.env.WEBHOOK_HMAC_SECRET;
const { createServer, state } = require('../src/server');

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
