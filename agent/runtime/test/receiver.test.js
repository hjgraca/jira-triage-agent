'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const path = require('path');

// Configure env BEFORE requiring the receiver (it loads the agent def at load).
process.env.WEBHOOK_HMAC_SECRET = 'b'.repeat(64);
process.env.SHARED_SECRET = 'c'.repeat(40);
process.env.AUTHORIZED_ACTORS = 'ALLOWED-1';
process.env.AGENT_IMAGE = 'repo/agent:test';
process.env.AGENT_PATH = path.join(__dirname, '..', '..', 'agents', 'jira-triage');

const SECRET = process.env.WEBHOOK_HMAC_SECRET;
const { createServer, setJobCreator, parseEnvList } = require('../receiver');

const sign = (body) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');

let server, port, created;
before(async () => {
  // Stub Job creation: record manifests; report a duplicate for a marked name.
  setJobCreator(async (manifest) => {
    created.push(manifest);
    return manifest.metadata.name.includes('dup') ? { duplicate: true } : { created: true };
  });
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
});
after(() => server.close());

function post(body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/webhook', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('unauthenticated POST → 401, no Job', async () => {
  created = [];
  const body = JSON.stringify({ webhookEvent: 'jira:issue_created', issue: { key: 'KAN-1' } });
  const r = await post(body); // no signature
  assert.strictEqual(r.status, 401);
  assert.strictEqual(created.length, 0);
});

test('authenticated eligible event → 200 and creates exactly one Job with RUN_VARS', async () => {
  created = [];
  const body = JSON.stringify({ webhookEvent: 'jira:issue_created', user: { accountId: 'X' }, issue: { key: 'KAN-2' } });
  const r = await post(body, { 'x-hub-signature': sign(body), 'x-atlassian-webhook-identifier': 'wid-2' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(created.length, 1);
  const c = created[0].spec.template.spec.containers[0];
  assert.strictEqual(c.image, 'repo/agent:test');
  assert.deepStrictEqual(JSON.parse(c.env.find((e) => e.name === 'RUN_VARS').value), { key: 'KAN-2' });
});

test('ineligible event (no label-add) → 200 drop, no Job', async () => {
  created = [];
  const body = JSON.stringify({
    webhookEvent: 'jira:issue_updated',
    user: { accountId: 'ALLOWED-1' },
    issue: { key: 'KAN-3' },
    changelog: { items: [{ field: 'summary', fromString: 'a', toString: 'b' }] },
  });
  const r = await post(body, { 'x-hub-signature': sign(body), 'x-atlassian-webhook-identifier': 'wid-3' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(created.length, 0);
});

test('duplicate delivery (409 from k8s) is acked 200, not an error', async () => {
  created = [];
  // dedupeId "dup-*" → stub returns { duplicate:true }; either way it's a 200.
  const body = JSON.stringify({ webhookEvent: 'jira:issue_created', user: { accountId: 'X' }, issue: { key: 'KAN-4' } });
  const r = await post(body, { 'x-hub-signature': sign(body), 'x-atlassian-webhook-identifier': 'dup-1' });
  assert.strictEqual(r.status, 200);
});

test('parseEnvList parses NAME=VALUE pairs', () => {
  assert.deepStrictEqual(parseEnvList('A=1,B=2'), [
    { name: 'A', value: '1' },
    { name: 'B', value: '2' },
  ]);
  assert.deepStrictEqual(parseEnvList(''), []);
});
