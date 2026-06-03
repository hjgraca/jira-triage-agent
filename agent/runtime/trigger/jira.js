'use strict';

// Jira trigger adapter — turns a Jira webhook (system webhook OR Automation
// rule) into the generic runner's {vars, actorId, dedupeId} and decides
// eligibility. All the Jira-specific shape lives here; the listener core is
// trigger-agnostic.

const { verifySignature, verifySharedSecret } = require('../lib/auth');

const TRIGGER_LABEL = process.env.TRIGGER_LABEL || 'triage';
const AUTOMATION_TOKEN_HEADER = 'x-triage-token';
// Event the Jira Automation rule sets in its custom body (it can't send a Jira
// changelog), eligible by construction — its own label condition is the gate.
const AUTOMATION_LABEL_EVENT = 'automation:label-added';

// The bot's own accountId, for the loop guard (drop the agent's own writes).
// This is Jira-specific config and lives HERE, in the Jira trigger — NOT in the
// engine. The operator sets it once (the docs show the GET /myself one-liner to
// obtain it); the engine never makes a Jira API call. A stateless fallback (the
// loop marker in the comment body) still guards if this is unset.
const BOT_ACCOUNT_ID = process.env.JIRA_BOT_ACCOUNT_ID || '';

/**
 * Authenticate: HMAC over the raw body (system webhook) OR a constant-time
 * shared-secret bearer (Automation rule, which can't sign). secrets = {hmac,
 * sharedSecret}. Returns { ok, via }.
 */
function authenticate(headers, rawBody, secrets) {
  if (verifySignature(rawBody, headers['x-hub-signature'], secrets.hmac)) {
    return { ok: true, via: 'hmac' };
  }
  if (secrets.sharedSecret && verifySharedSecret(headers[AUTOMATION_TOKEN_HEADER], secrets.sharedSecret)) {
    return { ok: true, via: 'shared-secret' };
  }
  return { ok: false };
}

/**
 * Extract dedupe id: Jira's native identifier, else the Automation rule's
 * X-Triage-Delivery-Id.
 */
function dedupeId(headers) {
  return headers['x-atlassian-webhook-identifier'] || headers['x-triage-delivery-id'];
}

/** Was the trigger label added in this update's changelog? */
function triageLabelAdded(payload) {
  const items = payload?.changelog?.items;
  if (!Array.isArray(items)) return false;
  return items.some((it) => {
    if (it.field !== 'labels' && it.fieldId !== 'labels') return false;
    const before = (it.fromString || '').split(/\s+/).filter(Boolean);
    const after = (it.toString || '').split(/\s+/).filter(Boolean);
    return after.includes(TRIGGER_LABEL) && !before.includes(TRIGGER_LABEL);
  });
}

// The agent's own comments start with its loop marker; a comment-add webhook
// carrying it is a self-write echo (stateless cold-start loop guard).
function payloadCarriesMarker(payload, marker) {
  const c = payload?.comment?.body;
  if (typeof c === 'string') return c.includes(marker);
  if (c && typeof c === 'object') {
    try {
      return JSON.stringify(c).includes(marker);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Decide what to do, given the parsed payload, the agent definition, and
 * runtime state. Returns { action:'spawn', vars } or { action:'drop', reason }.
 *
 * vars = template variables exposed to the agent's prompt ({{key}}).
 * state = { loopMarker } (the agent's self-write marker, from the agent def).
 */
function decide(payload, def, state) {
  const event = payload?.webhookEvent;
  const actorId = payload?.user?.accountId || null;

  // Loop guard (R7): drop the agent's own writes — by bot accountId (from this
  // trigger's own env config, not the engine), or statelessly by the agent's
  // loop marker appearing in the triggering comment.
  if (BOT_ACCOUNT_ID && actorId && actorId === BOT_ACCOUNT_ID) {
    return { action: 'drop', reason: 'loop-guard: bot accountId' };
  }
  if (state.loopMarker && payloadCarriesMarker(payload, state.loopMarker)) {
    return { action: 'drop', reason: 'loop-guard: self-write marker' };
  }

  const key = payload?.issue?.key;
  if (!key) return { action: 'drop', reason: 'no issue key' };

  // Eligibility: created, label-added (via changelog), or the Automation event.
  let eligible = false;
  let isLabelAdd = false;
  if (event === 'jira:issue_created') {
    eligible = true;
  } else if (event === 'jira:issue_updated' && triageLabelAdded(payload)) {
    eligible = true;
    isLabelAdd = true;
  } else if (event === AUTOMATION_LABEL_EVENT) {
    eligible = true;
    isLabelAdd = true;
  }
  if (!eligible) return { action: 'drop', reason: 'ineligible event' };

  // Authorization (R6b): label-adds must come from an allowlisted actor. The
  // allowlist comes from the agent definition (falling back to env in the core).
  if (isLabelAdd) {
    if (!actorId || !def.authorizedActors.has(actorId)) {
      return { action: 'drop', reason: 'unauthorized label actor' };
    }
  }

  return { action: 'spawn', vars: { key } };
}

module.exports = {
  name: 'jira',
  authenticate,
  dedupeId,
  decide,
  // exported for tests / parity
  triageLabelAdded,
  payloadCarriesMarker,
  TRIGGER_LABEL,
  AUTOMATION_LABEL_EVENT,
  BOT_ACCOUNT_ID,
};
