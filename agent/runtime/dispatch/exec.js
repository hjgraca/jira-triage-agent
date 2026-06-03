'use strict';

// Exec dispatcher: one-shot run = a local subprocess of the runner. For dev,
// the workshop lab, and single-node deployments where running Kubernetes Jobs
// (and granting the receiver RBAC to create them) is overkill.
//
// Because there is no Kubernetes here to provide dedupe + concurrency, this
// dispatcher owns them in-memory — exactly the state the production receiver
// must NOT hold. That's the deliberate trade: exec mode is single-process and
// not horizontally scalable; the k8s-job dispatcher is.

const { spawn } = require('child_process');
const path = require('path');
const { DedupeCache, SpawnLimiter } = require('../lib/limits');

const RUNNER = path.join(__dirname, '..', 'runner', 'main.js');

function createDispatcher(cfg) {
  const log = cfg.log || (() => {});
  const spawnFn = cfg.spawn || spawn; // injectable for tests
  const dedupe = new DedupeCache();
  const limiter = new SpawnLimiter({
    maxConcurrent: cfg.maxConcurrent,
    ceiling: cfg.ceiling,
    dailyBudget: cfg.dailyBudget,
  });
  const live = new Set();
  cfg.registerLive?.(live); // let the receiver signal children on shutdown

  return async function dispatch({ vars, dedupeId, label, agentPath, harness, model }) {
    if (dedupe.seenBefore(dedupeId)) return { accepted: false, duplicate: true };

    const slot = limiter.tryAcquire();
    if (!slot.ok) return { accepted: false, limited: slot.reason };

    const env = {
      ...process.env,
      AGENT_PATH: agentPath,
      HARNESS: harness,
      RUN_VARS: JSON.stringify(vars),
      RUN_LABEL: String(label),
    };
    if (model) env.MODEL = model;

    const child = spawnFn('node', [RUNNER], { stdio: ['ignore', 'inherit', 'inherit'], env });
    live.add(child);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      live.delete(child);
      limiter.release();
    };
    child.on('close', () => release());
    child.on('error', (err) => {
      release();
      // The run never started — let redelivery retry this id.
      dedupe.evict(dedupeId);
      log({ msg: 'run_spawn_error', label, error: err.message });
    });

    return { accepted: true };
  };
}

module.exports = { createDispatcher };
