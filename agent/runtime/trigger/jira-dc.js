'use strict';

// Jira Data Center / Server trigger adapter. Same shape as the Cloud adapter
// (trigger/jira.js) but for self-hosted Jira DC (tested against Jira 10.x),
// where two things differ on the wire:
//
//   1. The actor in a webhook is identified by `user.name` (or `user.key`),
//      NOT `user.accountId` (accountId is a Cloud-only concept). So the actor
//      allowlist (R6b) keys on the DC username/key.
//   2. There is no `x-atlassian-webhook-identifier` header. DC system webhooks
//      have no native delivery id, so dedupe falls back to a synthetic id built
//      from the issue key + the changelog id (stable per delivery), or the
//      X-Triage-Delivery-Id header if a front-end (Automation for Jira) sets one.
//
// Everything else is identical to Cloud and reused: HMAC auth over the raw body
// (DC system webhooks sign with X-Hub-Signature: sha256=…, which auth.js
// already validates), eligibility (created / label-added-via-changelog), and the
// stateless loop guard by the agent's own loop marker. The Cloud adapter is left
// untouched; pick this one with TRIGGER=jira-dc.

const { verifySignature, verifySharedSecret } = require('../lib/auth');

const TRIGGER_LABEL = process.env.TRIGGER_LABEL || 'triage';
const AUTOMATION_TOKEN_HEADER = 'x-triage-token';
// Event an Automation-for-Jira rule sets in its custom body when it can't send a
// changelog (the rule's own label condition is the gate). Same contract as Cloud.
const AUTOMATION_LABEL_EVENT = 'automation:label-added';

/**
 * Authenticate: HMAC over the raw body (DC system webhook, X-Hub-Signature) OR a
 * constant-time shared-secret bearer (Automation for Jira "Send web request",
 * which can't compute an HMAC). secrets = {hmac, sharedSecret}. Returns { ok, via }.
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
 * Extract the DC actor id — `user.name` (login) or `user.key`. There is no
 * accountId on Data Center. Returns null if neither is present.
 */
function actorIdOf(payload) {
  return payload?.user?.name || payload?.user?.key || null;
}

/**
 * Dedupe id. DC has no native webhook identifier header, so prefer a front-end
 * supplied X-Triage-Delivery-Id (Automation for Jira), else synthesize a stable
 * id from the issue key + the changelog id (unique per real delivery).
 */
function dedupeId(headers, payload) {
  if (headers['x-triage-delivery-id']) return headers['x-triage-delivery-id'];
  const key = payload?.issue?.key;
  const cid = payload?.changelog?.id;
  if (key && cid) return `${key}-${cid}`;
  return key || undefined;
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
// carrying it is a self-write echo (stateless cold-start loop guard). DC comment
// bodies are plain strings (wiki markup), so the string check is the common path.
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
 * Decide what to do, given the parsed payload and the agent definition.
 * Returns { action:'spawn', vars } or { action:'drop', reason }. Stateless: the
 * loop guard relies only on the agent's loop marker in the triggering comment.
 */
function decide(payload, def) {
  const event = payload?.webhookEvent;
  const actorId = actorIdOf(payload);

  // Loop guard (R7): drop the agent's own writes by its loop marker.
  if (def.loopMarker && payloadCarriesMarker(payload, def.loopMarker)) {
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

  // Authorization (R6b): label-adds must come from an allowlisted DC username/key.
  if (isLabelAdd) {
    if (!actorId || !def.authorizedActors.has(actorId)) {
      return { action: 'drop', reason: 'unauthorized label actor' };
    }
  }

  return { action: 'spawn', vars: { key } };
}

module.exports = {
  name: 'jira-dc',
  authenticate,
  dedupeId,
  decide,
  // exported for tests / parity
  actorIdOf,
  triageLabelAdded,
  payloadCarriesMarker,
  TRIGGER_LABEL,
  AUTOMATION_LABEL_EVENT,
};
