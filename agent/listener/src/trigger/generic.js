'use strict';

// Generic trigger adapter — a signed POST whose JSON body is passed straight
// through as the agent's prompt variables. For non-Jira agents (a GitHub
// webhook relay, a cron caller, an internal service) that just need to hand the
// agent some inputs and let the skill's prompt template do the rest.
//
// Auth: HMAC over the raw body (preferred) OR the shared-secret bearer. There is
// NO source-specific eligibility or loop guard here — a generic caller is
// trusted once authenticated; the skill's prompt + the spend limiter + egress
// fence are the controls. If you need richer gating, write a dedicated trigger
// adapter (like jira.js).
//
// Body shape:
//   { "vars": { ... }, "dedupeId"?: "..." }   // vars become {{...}} in the prompt
// or any flat JSON object, which is used directly as vars.

const { verifySignature, verifySharedSecret } = require('../auth');

const TOKEN_HEADER = process.env.GENERIC_TOKEN_HEADER || 'x-triage-token';

function authenticate(headers, rawBody, secrets) {
  if (verifySignature(rawBody, headers['x-hub-signature'], secrets.hmac)) {
    return { ok: true, via: 'hmac' };
  }
  if (secrets.sharedSecret && verifySharedSecret(headers[TOKEN_HEADER], secrets.sharedSecret)) {
    return { ok: true, via: 'shared-secret' };
  }
  return { ok: false };
}

function dedupeId(headers, payload) {
  return (
    headers['x-triage-delivery-id'] ||
    headers['x-atlassian-webhook-identifier'] ||
    (payload && payload.dedupeId) ||
    undefined
  );
}

function decide(payload) {
  const vars = payload && typeof payload.vars === 'object' && payload.vars !== null
    ? payload.vars
    : payload && typeof payload === 'object'
      ? payload
      : {};
  return { action: 'spawn', vars };
}

module.exports = { name: 'generic', authenticate, dedupeId, decide };
