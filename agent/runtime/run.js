'use strict';

// One-shot runner. This is the entrypoint of an AGENT image, run as a Kubernetes
// Job (one per event). It does exactly one thing then exits:
//   load the agent definition → render its prompt from RUN_VARS → spawn the
//   harness CLI → exit with the harness's exit code.
//
// No webhook, no auth, no dedupe, no rate limiting, no watchdog — Kubernetes
// owns all of that now (the Job's name is the dedupe key, a ResourceQuota caps
// concurrency, and activeDeadlineSeconds is the timeout). Keeping this process
// dumb is the point of the run-as-Job model.

const { spawn } = require('child_process');
const { getAdapter } = require('./harness');
const { loadAgentDef, renderPrompt } = require('./lib/agent-def');

const AGENT_PATH = process.env.AGENT_PATH || '/agent';
const MODEL = process.env.MODEL || '';

function main() {
  const { adapter: harness } = getAdapter(process.env.HARNESS);
  const def = loadAgentDef(AGENT_PATH);

  // The receiver passes the trigger's parsed vars as a JSON env var.
  let vars = {};
  try {
    vars = JSON.parse(process.env.RUN_VARS || '{}');
  } catch {
    console.error('run: RUN_VARS is not valid JSON');
    process.exit(1);
  }

  const prompt = renderPrompt(def.prompt, vars);
  const cmd = harness.buildCommand({
    vars,
    skillPath: AGENT_PATH,
    model: MODEL || def.model,
    prompt,
    trustTools: def.trustTools,
  });

  const child = spawn(cmd.bin, cmd.args, {
    stdio: 'inherit', // surface the harness's own output as the Job's logs
    env: cmd.env ? { ...process.env, ...cmd.env } : process.env,
  });

  const runState = {};
  // Streaming harnesses can flag a tool error mid-run; with stdio:'inherit' we
  // don't tee stdout, so we rely on the exit code (finalize backstops on it).
  child.on('close', (code) => {
    const { toolError } = harness.finalize(code, runState);
    // Non-zero exit (or a flagged tool error) fails the Job → K8s backoff/alert.
    process.exit(toolError ? code || 1 : 0);
  });
  child.on('error', (err) => {
    console.error(`run: failed to spawn harness: ${err.message}`);
    process.exit(1);
  });
}

main();
