'use strict';

// Dispatch registry — how an accepted event becomes a one-shot run. Selected by
// the DISPATCH env (default k8s-job). Symmetric with the trigger + harness
// registries.
//
//   k8s-job  (default) create a Kubernetes Job per event; K8s provides dedupe
//            (deterministic name → 409) + concurrency (ResourceQuota). The
//            receiver is stateless and horizontally scalable.
//   exec     spawn the runner as a local subprocess; dedupe + concurrency are
//            in-memory in the dispatcher. Single-process; for dev/workshop.
//
// A dispatcher factory takes config and returns:
//   dispatch({vars, dedupeId, label, agentPath, harness, model})
//     -> { accepted: true } | { accepted: false, duplicate?: true, limited?: reason }

const FACTORIES = {
  'k8s-job': () => require('./k8s-job').createDispatcher,
  exec: () => require('./exec').createDispatcher,
};

function getDispatcherFactory(name) {
  const key = (name || 'k8s-job').trim();
  const factory = FACTORIES[key];
  if (!factory) {
    throw new Error(
      `unknown DISPATCH '${key}'. Known: ${Object.keys(FACTORIES).join(', ')}. ` +
        `Add one under src/dispatch/ to support a new run backend.`
    );
  }
  return { name: key, createDispatcher: factory() };
}

module.exports = { getDispatcherFactory };
