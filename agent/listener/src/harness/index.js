'use strict';

// Harness registry — selects the coding-agent CLI the listener spawns per
// webhook, so the same listener works with any headless harness (pi, kiro-cli,
// or a customer's own). Pick via the HARNESS env var (default: pi).
//
// Each adapter implements the contract documented in ./README.md:
//   buildCommand(ctx) -> { bin, args, env? }   // how to invoke the harness
//   interpret?(line, state)                     // OPTIONAL: parse a stdout line
//                                               //   (streaming harnesses only)
//   finalize(code, state) -> { toolError }      // classify the run from exit
//                                               //   code + accumulated state
//
// ctx = { key, skillPath, model, prompt } — the issue key, the baked skill dir,
// the configured model id, and the base triage prompt.

const pi = require('./pi');
const kiroCli = require('./kiro-cli');

const ADAPTERS = {
  pi,
  'kiro-cli': kiroCli,
};

/**
 * Resolve the active harness adapter. Throws on an unknown name so a
 * misconfigured HARNESS fails loudly at startup rather than silently spawning
 * the wrong (or no) binary per webhook.
 */
function getAdapter(name) {
  const key = (name || 'pi').trim();
  const adapter = ADAPTERS[key];
  if (!adapter) {
    throw new Error(
      `unknown HARNESS '${key}'. Known: ${Object.keys(ADAPTERS).join(', ')}. ` +
        `Add an adapter under src/harness/ to support a new one (see README.md).`
    );
  }
  return { name: key, adapter };
}

module.exports = { getAdapter, ADAPTERS };
