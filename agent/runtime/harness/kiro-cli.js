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

const { composeInlineSkillPrompt } = require('./inline-skill');

const KIRO_BIN = process.env.KIRO_BIN || 'kiro-cli';
// Least-privilege tool grant (best practice over --trust-all-tools): the skill
// reads tickets/code and executes the bundled bash scripts, so it needs read +
// execute. Precedence: the agent definition's `trustTools` (ctx) → KIRO_TRUST_TOOLS
// env → safe default.
const DEFAULT_TRUST_TOOLS = process.env.KIRO_TRUST_TOOLS || 'read,execute_bash';

module.exports = {
  buildCommand({ skillPath, prompt, trustTools }) {
    // Note: model selection is not a `chat` flag in kiro-cli (it's set via the
    // configured default model / agent), so `model` from ctx is intentionally
    // unused here — see docs/customer-install/03b-choose-harness.md.
    const trust = trustTools || DEFAULT_TRUST_TOOLS;
    return {
      bin: KIRO_BIN,
      args: [
        'chat',
        '--no-interactive',
        `--trust-tools=${trust}`,
        composeInlineSkillPrompt(skillPath, prompt),
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
};
