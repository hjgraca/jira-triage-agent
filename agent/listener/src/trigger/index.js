'use strict';

// Trigger registry — selects how an inbound webhook is authenticated, parsed
// into prompt variables, and gated. Pick via the TRIGGER env var (default:
// jira). Symmetric with the harness registry: triggers feed the runner, harness
// adapters run the agent.
//
// A trigger adapter implements:
//   authenticate(headers, rawBody, secrets) -> { ok, via }
//   dedupeId(headers, payload?) -> string|undefined
//   decide(payload, def, state) -> { action:'spawn', vars } | { action:'drop', reason }

const jira = require('./jira');
const generic = require('./generic');

const TRIGGERS = {
  jira,
  generic,
};

function getTrigger(name) {
  const key = (name || 'jira').trim();
  const trigger = TRIGGERS[key];
  if (!trigger) {
    throw new Error(
      `unknown TRIGGER '${key}'. Known: ${Object.keys(TRIGGERS).join(', ')}. ` +
        `Add an adapter under src/trigger/ to support a new event source.`
    );
  }
  return { name: key, trigger };
}

module.exports = { getTrigger, TRIGGERS };
