'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { verifySignature, verifySharedSecret } = require('../lib/auth');

const SECRET = 'a'.repeat(64);
function sign(body, secret = SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// --- HMAC (R10/R10a) ---------------------------------------------------------
test('valid signature over the exact raw body is accepted', () => {
  const body = Buffer.from(JSON.stringify({ webhookEvent: 'jira:issue_created' }));
  assert.strictEqual(verifySignature(body, sign(body), SECRET), true);
});

test('tampered body is rejected', () => {
  const body = Buffer.from('{"a":1}');
  const sig = sign(body);
  assert.strictEqual(verifySignature(Buffer.from('{"a":2}'), sig, SECRET), false);
});

test('missing signature header is rejected', () => {
  assert.strictEqual(verifySignature(Buffer.from('{}'), undefined, SECRET), false);
});

test('wrong algorithm prefix is rejected', () => {
  const body = Buffer.from('{}');
  assert.strictEqual(verifySignature(body, sign(body).replace('sha256=', 'md5='), SECRET), false);
});

test('length-mismatched signature is rejected without throwing', () => {
  assert.strictEqual(verifySignature(Buffer.from('{}'), 'sha256=abcd', SECRET), false);
});

// --- shared secret (R10a-bis) ------------------------------------------------
test('correct shared secret is accepted', () => {
  assert.strictEqual(verifySharedSecret('s3cret-token', 's3cret-token'), true);
});

test('wrong shared secret is rejected', () => {
  assert.strictEqual(verifySharedSecret('nope', 's3cret-token'), false);
});

test('missing shared secret header or unset secret is rejected', () => {
  assert.strictEqual(verifySharedSecret(undefined, 's3cret-token'), false);
  assert.strictEqual(verifySharedSecret('s3cret-token', ''), false);
});

test('length-mismatched shared secret is rejected without throwing (constant-time guard)', () => {
  assert.strictEqual(verifySharedSecret('short', 'a-much-longer-secret'), false);
});
