'use strict';

// pi.dev adapter — https://github.com/earendil-works/pi
//
// pi runs headless with `--mode json`, emitting a stream of JSON events on
// stdout. It loads the skill directly via `--skill` (no need to inline the
// rubric), and authenticates to Bedrock via IRSA (no harness API key — the
// pod's ServiceAccount supplies AWS creds), so this adapter adds no env.

const PI_BIN = process.env.PI_BIN || 'pi';

module.exports = {
  /**
   * pi loads the skill by path and is told the single issue key to act on.
   * Streaming JSON means we can watch for terminal/error events in interpret().
   */
  buildCommand({ skillPath, model, prompt }) {
    return {
      bin: PI_BIN,
      args: [
        '--mode',
        'json',
        '--provider',
        'amazon-bedrock',
        '--model',
        model,
        '--skill',
        skillPath,
        prompt,
      ],
      // No extra env: IRSA injects AWS_WEB_IDENTITY_TOKEN_FILE + AWS_ROLE_ARN.
    };
  },

  /**
   * Parse one stdout line of pi's JSON event stream. Mutates `state`:
   *   - state.toolError  ← any tool_execution_end with isError
   *   - state.agentEnded ← the agent_end terminal event (for logging)
   * Non-JSON / partial lines are ignored.
   */
  interpret(line, state) {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const ev = JSON.parse(trimmed);
      if (ev.type === 'tool_execution_end' && ev.isError) state.toolError = true;
      if (ev.type === 'agent_end') state.agentEnded = true;
    } catch {
      /* partial line; ignore */
    }
  },

  /**
   * Final classification. pi signals tool errors in-stream (captured above), so
   * trust state.toolError; treat a non-zero exit as an error too.
   */
  finalize(code, state) {
    return { toolError: !!state.toolError || code !== 0 };
  },
};
