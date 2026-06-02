'use strict';

// opencode adapter — https://opencode.ai/docs/cli
//
// WHY `opencode run` AND NOT `opencode serve`:
//   opencode has two headless shapes. `serve` is a long-lived HTTP daemon
//   (POST /session -> POST /session/:id/message); it has NO per-ticket process
//   and NO exit code, so it does NOT fit this listener's subprocess contract
//   (buildCommand -> spawn -> finalize-on-exit), and a persistent server would
//   fight the per-run security model (one ephemeral, gated, spend-limited run
//   per webhook). `opencode run "<prompt>"` is the non-interactive,
//   spawn-and-exit shape that matches — so this adapter uses it.
//   (If warm starts ever matter, `opencode run --attach http://host:port`
//   bridges to a serve daemon WITHOUT changing this adapter's contract.)
//
// Like kiro-cli, opencode has no `--skill` flag, so the rubric is inlined into
// the prompt and the agent runs the bundled bash scripts as tools.
//
// Auth/model: credentials come from `opencode auth login` (~/.local/share/
// opencode/auth.json) or provider env vars / a .env — provisioned at deploy
// time, not by this adapter. Model is `provider/model` via -m.

const { composeInlineSkillPrompt } = require('./inline-skill');

const OPENCODE_BIN = process.env.OPENCODE_BIN || 'opencode';
// provider/model form (e.g. "anthropic/claude-sonnet-4-6" or
// "amazon-bedrock/..."). Defaults to the shared TRIAGE_MODEL only if it already
// carries a provider prefix; otherwise leave it to opencode's configured
// default. Set OPENCODE_MODEL explicitly for control.
const OPENCODE_MODEL = process.env.OPENCODE_MODEL || '';

module.exports = {
  buildCommand({ skillPath, model, prompt }) {
    const args = ['run', '--format', 'json'];

    // Only pass --model when we have a provider/model-shaped id. opencode needs
    // the provider prefix; a bare model id (the pi/Bedrock default) would be
    // rejected, so fall through to opencode's own default in that case.
    const m = OPENCODE_MODEL || (model && model.includes('/') ? model : '');
    if (m) args.push('--model', m);

    // Auto-approve permissions: there is no human to confirm tool calls in a
    // one-shot run. The skill scripts are the real guardrail (allowed-value
    // sets, read-only GitLab), and egress is fenced by NetworkPolicy.
    args.push('--dangerously-skip-permissions');

    args.push(composeInlineSkillPrompt(skillPath, prompt));
    return { bin: OPENCODE_BIN, args };
    // Credentials are inherited from process.env / auth.json; nothing to add.
  },

  /**
   * `--format json` emits raw JSON events. Their exact shape isn't contractually
   * stable, so parse defensively: flag a tool error if an event looks like a
   * failed tool/part, otherwise ignore. finalize() still backstops on exit code.
   */
  interpret(line, state) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      return; // partial / non-JSON line
    }
    // Best-effort across plausible event shapes: a tool/part whose status or
    // state indicates an error.
    const status = ev?.state?.status || ev?.status;
    const isToolish = ev?.type === 'tool' || ev?.part?.type === 'tool' || ev?.tool;
    if (isToolish && (status === 'error' || ev?.error || ev?.state?.error)) {
      state.toolError = true;
    }
  },

  /**
   * Trust an in-stream tool error if we saw one; otherwise treat a non-zero
   * exit as failure.
   */
  finalize(code, state) {
    return { toolError: !!(state && state.toolError) || code !== 0 };
  },
};
