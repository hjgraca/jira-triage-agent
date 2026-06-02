'use strict';

// kiro-cli adapter — https://kiro.dev/docs/cli/headless.md
//
// Key differences from pi that shape this adapter:
//   - NO `--skill` flag. kiro loads context via agents/KIRO_HOME, not a skill
//     path. So we inline the rubric (SKILL.md) into the prompt and instruct the
//     agent to run the bundled bash scripts (jira.sh / gitlab.sh) as tools.
//   - NO streaming JSON. `--no-interactive` prints the final response as prose
//     to stdout, so there is nothing to parse mid-run — interpret() is omitted
//     and the run is classified purely from the process exit code.
//   - Auth is its OWN backend via KIRO_API_KEY (not Bedrock/IRSA). The key is
//     injected from the Kubernetes secret by server.js; this adapter only
//     declares the binary + flags.
//
// Exit codes (https://kiro.dev/docs/cli/reference/exit-codes.md):
//   0 success | 1 generic failure (auth/args/op) | 3 MCP startup failure.

const fs = require('fs');
const path = require('path');

const KIRO_BIN = process.env.KIRO_BIN || 'kiro-cli';
// Least-privilege tool grant (best practice over --trust-all-tools): the skill
// reads tickets/code and executes the bundled bash scripts, so it needs read +
// execute. Override via KIRO_TRUST_TOOLS if a deployment needs a different set.
const TRUST_TOOLS = process.env.KIRO_TRUST_TOOLS || 'read,execute_bash';

// Cache the inlined rubric so we read SKILL.md once, not per webhook.
let cachedRubric = null;
function loadRubric(skillPath) {
  if (cachedRubric !== null) return cachedRubric;
  try {
    cachedRubric = fs.readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8');
  } catch {
    cachedRubric = ''; // fail soft: the prompt still names the scripts to run
  }
  return cachedRubric;
}

// Build a self-contained prompt for a harness with no skill-loading: the rubric
// text, the scripts to use, and the one issue key to act on.
function composePrompt(skillPath, basePrompt) {
  const rubric = loadRubric(skillPath);
  const scripts = path.join(skillPath, 'scripts');
  return [
    'You are running the jira-triage skill headlessly. Follow the rubric below',
    'exactly. Use ONLY these bundled scripts for all Jira/GitLab access (run them',
    `via the shell): ${scripts}/jira.sh and ${scripts}/gitlab.sh. Do not call the`,
    'Jira or GitLab APIs directly — the scripts enforce auth and allowed-value',
    'bounds. When finished, stop.',
    '',
    '----- BEGIN SKILL RUBRIC (SKILL.md) -----',
    rubric,
    '----- END SKILL RUBRIC -----',
    '',
    basePrompt,
  ].join('\n');
}

module.exports = {
  buildCommand({ skillPath, prompt }) {
    // Note: model selection is not a `chat` flag in kiro-cli (it's set via the
    // configured default model / agent), so `model` from ctx is intentionally
    // unused here — see docs/customer-install/03b-choose-harness.md.
    return {
      bin: KIRO_BIN,
      args: [
        'chat',
        '--no-interactive',
        `--trust-tools=${TRUST_TOOLS}`,
        composePrompt(skillPath, prompt),
      ],
      // KIRO_API_KEY is injected by server.js from the secret; nothing to add.
    };
  },

  // No mid-run stream to parse: interpret is intentionally absent.

  /**
   * Classify from the exit code alone. 0 = success; anything else is an error
   * (1 generic, 3 MCP-startup). There is no in-band tool-error signal.
   */
  finalize(code) {
    return { toolError: code !== 0 };
  },

  // Exposed for unit testing the prompt composition.
  _composePrompt: composePrompt,
  _resetCache() {
    cachedRubric = null;
  },
};
