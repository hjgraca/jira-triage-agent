# Live end-to-end test

`e2e.sh` drives the **real ingress chain** the agent runs in production —
CloudFront → NLB → receiver → Kubernetes Job → `run.js` → harness — and asserts
each link. It's the live counterpart to the unit suites (`agent/runtime/test/`
for the engine, `agent/agents/jira-triage/tests/` for the skill scripts), which
run offline with stubs.

## Run it

```bash
# from the repo root, with kubectl pointed at the cluster
make agent-e2e             # full run, stop on first failure
make agent-e2e-step        # step-by-step: explains + pauses before each stage

# or directly:
agent/deploy/test/e2e.sh
agent/deploy/test/e2e.sh --step
```

`--step` is the one to use when you want to **watch what happens at each stage**:
it prints what the stage proves and why, then waits for Enter before sending the
request — so you can tail the receiver (`kubectl -n agents logs -l
app.kubernetes.io/name=agent-receiver -f`) or watch Jobs
(`kubectl -n agents get jobs -w`) in another pane and see each link fire.

## What each stage proves

| # | Stage | Asserts |
|---|-------|---------|
| 1 | Health through CloudFront | `GET /healthz`+`/readyz` = 200 → CF → NLB → receiver is up |
| 2 | Origin lock | a direct hit to the NLB (bypassing CloudFront) is refused |
| 3 | Auth | a bad-signature webhook is rejected `401` (auth runs before parse/gate) |
| 4 | Eligibility gate | a valid-but-ineligible event is dropped `200` with **no** Job |
| 5 | Spawn | a real `automation:label-added` event creates exactly one run Job |
| 6 | Dedupe | re-sending the same delivery id creates **no** second Job (409) |
| 7 | Concurrency quota | the ResourceQuota uses the non-terminal `pods` key, not `count/pods` |
| 8 | Run completes | the Job finishes and triages the ticket (posts an audit comment) |

## Configuration

All optional — defaults are auto-discovered from terraform + the cluster:

| Env | Default | Meaning |
|---|---|---|
| `WEBHOOK_URL` | `terraform output triage_webhook_url` | the CloudFront webhook URL to drive |
| `TF_DIR` | `workshop/terraform` | terraform dir to read the URL output from |
| `NS` | `agents` | the agent namespace |
| `E2E_ISSUE_KEY` | `KAN-2` | **throwaway** Jira issue the runs triage (writes land here) |
| `E2E_ACTOR_ID` | first `AUTHORIZED_ACTORS` id on the receiver | the authorized triggering actor |
| `WAIT_RUN` | `300` | seconds to wait for the run in stage 8 (`0` = don't wait) |

The auth secrets and the actor id are read **read-only** from the live
deployment (`agents/agent-secrets`, the receiver env) so the synthetic webhooks
are valid against it — nothing is hardcoded.

## Safety

Read-mostly against the cluster and Jira. The only writes are:

- POSTing synthetic webhooks to the receiver, which spawn run Jobs that triage
  **`$E2E_ISSUE_KEY`** — point it at a throwaway ticket, not a real one.
- Deleting the run Job the test created, during cleanup.

It never edits the manifests, the terraform, or any cluster config.
