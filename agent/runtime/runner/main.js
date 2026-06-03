'use strict';

// One-shot runner: the program a single run executes (a K8s Job, or a
// subprocess in exec mode). It does ONE thing — run the agent's harness once
// for one event, then exit — and nothing else. No HTTP, no dedupe, no limiter,
// no concurrency control: the dispatcher (K8s Jobs + ResourceQuota, or the exec
// dispatcher) owns all of that. The process exit code IS the result.
//
// Inputs (from env, so a Job spec carries them as plain env vars):
//   AGENT_PATH   the agent dir whose SKILL.md frontmatter drives the run
//   HARNESS      which coding-agent CLI to spawn (default pi)
//   MODEL        model id (else the agent definition's, else a default)
//   RUN_VARS     JSON object of prompt template variables (e.g. {"key":"KAN-5"})
//   RUN_LABEL    short label for logs (optional; derived from vars otherwise)
//   RUN_TIMEOUT_MS  watchdog ceiling (default 300000)

const { spawn } = require('child_process');
const { getAdapter } = require('../harness');
const { loadAgentDef, renderPrompt } = require('../lib/agent-def');

function log(obj) {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n');
}

function parseVars(raw) {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function labelFor(vars) {
  return process.env.RUN_LABEL || vars.key || vars.id || vars.label || Object.values(vars)[0] || 'run';
}

async function run() {
  const agentPath = process.env.AGENT_PATH || process.env.SKILL_PATH;
  if (!agentPath) throw new Error('AGENT_PATH is required');

  const { name: harnessName, adapter: harness } = getAdapter(process.env.HARNESS);
  const agentDef = loadAgentDef(agentPath);
  const model = process.env.MODEL || agentDef.model || 'us.anthropic.claude-sonnet-4-6';
  const timeoutMs = parseInt(process.env.RUN_TIMEOUT_MS || '300000', 10);
  const vars = parseVars(process.env.RUN_VARS);
  const label = labelFor(vars);

  const prompt = renderPrompt(agentDef.prompt, vars);
  const cmd = harness.buildCommand({
    vars,
    skillPath: agentPath,
    model,
    prompt,
    trustTools: agentDef.trustTools,
  });

  log({ msg: 'run_start', label, harness: harnessName, agent: agentDef.name });

  const child = spawn(cmd.bin, cmd.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cmd.env ? { ...process.env, ...cmd.env } : process.env,
  });

  const runState = {};

  // Watchdog: a hung harness emits neither 'close' nor 'error'. SIGTERM then
  // SIGKILL after a grace, and exit non-zero so the Job records a failure.
  const watchdog = setTimeout(() => {
    log({ msg: 'run_timeout', label, harness: harnessName, timeoutMs });
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
  }, timeoutMs);
  watchdog.unref();

  if (typeof harness.interpret === 'function') {
    child.stdout.on('data', (buf) => {
      for (const line of buf.toString().split('\n')) harness.interpret(line, runState);
    });
  }

  return new Promise((resolve) => {
    child.on('close', (code) => {
      clearTimeout(watchdog);
      if (runState.agentEnded) log({ msg: 'run_done', label, harness: harnessName });
      const { toolError } = harness.finalize(code, runState);
      log({ msg: 'run_exit', label, harness: harnessName, code, toolError });
      // Surface a tool error as a non-zero exit so the Job (or exec caller) sees
      // failure even when the harness process itself exited 0.
      resolve(toolError ? 1 : 0);
    });
    child.on('error', (err) => {
      clearTimeout(watchdog);
      log({ msg: 'run_spawn_error', label, harness: harnessName, error: err.message });
      resolve(1);
    });
  });
}

if (require.main === module) {
  run()
    .then((code) => process.exit(code))
    .catch((err) => {
      log({ msg: 'run_fatal', error: err.message });
      process.exit(1);
    });
}

module.exports = { run };
