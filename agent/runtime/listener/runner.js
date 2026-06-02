'use strict';

// The per-run lifecycle: spawn the harness for one accepted event, then own the
// invariants that must hold no matter which trigger/agent/harness is plugged in:
//   - render the agent's prompt from the trigger vars
//   - spawn the harness child (adapter-built argv + env)
//   - watchdog kill for a hung run (so a stuck run can't hold a limiter slot)
//   - release the limiter slot EXACTLY once (error + close can both fire)
//   - stream parsing (interpret) / exit classification (finalize)
//   - evict the dedupe id on spawn failure so redelivery can retry
//
// Extracted from server.js so the HTTP shell only wires auth → gate → run, and
// this lifecycle is unit-reasoned in one place.

const { spawn } = require('child_process');
const { renderPrompt } = require('./agent-def');

/**
 * Build a spawnRun(vars, dedupeId, label) bound to its dependencies.
 *
 * deps = {
 *   harness,            // adapter: buildCommand / interpret? / finalize
 *   harnessName,        // for logs
 *   agentDef,           // { prompt, trustTools, ... } — the skill defines the agent
 *   skillPath, model,   // passed to buildCommand
 *   limiter,            // SpawnLimiter (slot released here)
 *   dedupe,             // DedupeCache (evicted on spawn failure)
 *   liveChildren,       // Set tracked by the server for graceful shutdown
 *   log,                // structured logger
 *   timeoutMs,          // watchdog ceiling
 * }
 */
function createRunner(deps) {
  const {
    harness,
    harnessName,
    agentDef,
    skillPath,
    model,
    limiter,
    dedupe,
    liveChildren,
    log,
    timeoutMs,
  } = deps;

  return function spawnRun(vars, dedupeId, label) {
    const prompt = renderPrompt(agentDef.prompt, vars);
    const cmd = harness.buildCommand({
      vars,
      skillPath,
      model,
      prompt,
      trustTools: agentDef.trustTools,
    });
    const child = spawn(cmd.bin, cmd.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Merge adapter-declared env onto the inherited process env (IRSA vars,
      // KIRO_API_KEY, etc. are already in process.env from the pod spec).
      env: cmd.env ? { ...process.env, ...cmd.env } : process.env,
    });
    liveChildren.add(child);

    // Per-run accumulator the adapter mutates via interpret()/reads in finalize().
    const runState = {};

    // Release the limiter slot EXACTLY once: a failed spawn emits both 'error'
    // and 'close', so a flag prevents a double-release that would corrupt the
    // concurrency count and defeat the R10c storm/loop defense.
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      clearTimeout(watchdog);
      liveChildren.delete(child);
      limiter.release();
    };

    // Watchdog: a hung run (model slow/unreachable, harness stuck) emits neither
    // 'close' nor 'error', so without this the slot leaks forever and enough
    // stuck runs silently wedge all work. SIGTERM then SIGKILL after a grace.
    const watchdog = setTimeout(() => {
      log({ msg: 'run_timeout', label, harness: harnessName, timeoutMs });
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }, timeoutMs);
    watchdog.unref();

    // Streaming harnesses parse stdout line-by-line; non-streaming ones omit
    // interpret() and are classified from the exit code in finalize(). Never log
    // full payloads (ticket bodies carry PII).
    if (typeof harness.interpret === 'function') {
      child.stdout.on('data', (buf) => {
        for (const line of buf.toString().split('\n')) harness.interpret(line, runState);
      });
    }
    child.on('close', (code) => {
      releaseOnce();
      if (runState.agentEnded) log({ msg: 'run_done', label, harness: harnessName });
      const { toolError } = harness.finalize(code, runState);
      log({ msg: 'run_exit', label, harness: harnessName, code, toolError });
    });
    child.on('error', (err) => {
      releaseOnce();
      // The run never happened — let the trigger's redelivery of this id retry.
      dedupe.evict(dedupeId);
      log({ msg: 'run_spawn_error', label, harness: harnessName, error: err.message });
    });

    return child;
  };
}

module.exports = { createRunner };
