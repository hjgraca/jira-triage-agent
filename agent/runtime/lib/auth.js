'use strict';

// Trigger-agnostic request authentication primitives (constant-time). Used by
// trigger adapters to authenticate inbound webhooks; no Jira/agent specifics
// here so any trigger can reuse them.

const crypto = require('crypto');

// HMAC signature header shape: `<algo>=<hexdigest>` (e.g. Jira's
// X-Hub-Signature, historically sha256). VERIFY the algorithm/prefix against a
// real captured header before trusting the 401 path in production.
const SIGNATURE_ALGO = 'sha256';

/**
 * Constant-time HMAC validation over the EXACT raw body bytes (R10/R10a).
 * Returns true only if the recomputed digest matches the header signature.
 * Uses crypto.timingSafeEqual — never a string === compare.
 */
function verifySignature(rawBody, headerValue, secret) {
  if (!headerValue || !secret) return false;
  const eq = headerValue.indexOf('=');
  const algo = eq === -1 ? SIGNATURE_ALGO : headerValue.slice(0, eq);
  const sentHex = eq === -1 ? headerValue : headerValue.slice(eq + 1);
  if (algo !== SIGNATURE_ALGO) return false;

  const expected = crypto.createHmac(SIGNATURE_ALGO, secret).update(rawBody).digest();
  let sent;
  try {
    sent = Buffer.from(sentHex, 'hex');
  } catch {
    return false;
  }
  // timingSafeEqual throws on length mismatch; guard so we still compare in
  // constant time relative to equal-length forgeries.
  if (sent.length !== expected.length) return false;
  return crypto.timingSafeEqual(sent, expected);
}

/**
 * Constant-time shared-secret check (R10a-bis) for callers that cannot compute
 * an HMAC over the body (e.g. Jira Cloud Automation's "Send web request", which
 * has no smart-value crypto). The caller sends a fixed bearer token in a custom
 * header; we compare it in constant time. Weaker than per-message HMAC (a static
 * token is replayable if leaked), so it must lean on other layers: the
 * CloudFront-origin IP lock (R10b), the actor allowlist (R6b), dedupe (R8), and
 * the daily budget (R10c). Prefer HMAC for any source that can sign.
 */
function verifySharedSecret(headerValue, secret) {
  if (!headerValue || !secret) return false;
  const sent = Buffer.from(String(headerValue));
  const expected = Buffer.from(String(secret));
  if (sent.length !== expected.length) return false;
  return crypto.timingSafeEqual(sent, expected);
}

module.exports = { verifySignature, verifySharedSecret, SIGNATURE_ALGO };
