'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const path = require('path');

// Configure the receiver BEFORE requiring it. Use exec dispatch (no K8s) and
// point AGENT_PATH at the real jira-triage skill so loadAgentDef succeeds.
process.env.WEBHOOK_HMAC_SECRET = 'b'.repeat(64);
process.env.WEBHOOK_SHARED_SECRET = 'c'.repeat(48);
process.env.AUTHORIZED_ACTORS = 'ALLOWED-1';
process.env.TRIGGER = 'jira';
process.env.DISPATCH = 'exec';
process.env.MAX_CONCURRENT = '0'; // force the limiter to refuse — no real run spawns
process.env.AGENT_PATH = path.join(__dirname, '..', '..', 'agents', 'jira-triage');

const SECRET = process.env.WEBHOOK_HMAC_SECRET;
const { createServer } = require('../receiver/server');

let server;
let port;
before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
});
after(() => server.close());

function sign(body) {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}
function post(body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/webhook', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
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

test('unauthenticated POST → 401', async () => {
  const body = JSON.stringify({ webhookEvent: 'jira:issue_created', issue: { key: 'KAN-1' } });
  assert.strictEqual((await post(body)).status, 401);
});

test('valid HMAC + ineligible event → 200 drop (no dispatch)', async () => {
  const body = JSON.stringify({
    webhookEvent: 'jira:issue_updated',
    user: { accountId: 'ALLOWED-1' },
    issue: { key: 'KAN-2' },
    changelog: { items: [{ field: 'summary', fromString: 'a', toString: 'b' }] },
  });
  const r = await post(body, { 'x-hub-signature': sign(body), 'x-atlassian-webhook-identifier': 'w1' });
  assert.strictEqual(r.status, 200);
});

test('valid HMAC + eligible event → 200 (dispatch attempted; limiter refuses at MAX_CONCURRENT=0)', async () => {
  const body = JSON.stringify({
    webhookEvent: 'jira:issue_created',
    user: { accountId: 'X' },
    issue: { key: 'KAN-3' },
  });
  const r = await post(body, { 'x-hub-signature': sign(body), 'x-atlassian-webhook-identifier': 'w2' });
  assert.strictEqual(r.status, 200); // ack regardless; limiter drop is logged
});

test('shared-secret auth path is accepted', async () => {
  const body = JSON.stringify({
    webhookEvent: 'automation:label-added',
    user: { accountId: 'ALLOWED-1' },
    issue: { key: 'KAN-4' },
  });
  const r = await post(body, { 'x-triage-token': process.env.WEBHOOK_SHARED_SECRET, 'x-triage-delivery-id': 'w3' });
  assert.strictEqual(r.status, 200);
});

test('/readyz is ready immediately (no bot-identity wait — engine is agnostic)', async () => {
  const code = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/readyz' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
  });
  assert.strictEqual(code, 200);
});
