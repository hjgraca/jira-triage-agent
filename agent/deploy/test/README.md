# Live end-to-end test

`e2e.sh` drives the **real ingress chain** the agent runs in production —
CloudFront → NLB → receiver → Kubernetes Job → `run.js` → harness — and asserts
each link. It's the live counterpart to the unit suites (`runtime/test/` for the
engine, `agents/jira-triage/tests/` for the skill scripts), which run offline
with stubs.

> **Cloud / CloudFront path only.** This script asserts the CloudFront→NLB chain,
> which **does not exist** on the Jira **Data Center / in-cluster** deploy (the
> receiver is a `ClusterIP` Jira reaches directly). It also reads its webhook URL
> from a Terraform output (`TF_DIR`, default `workshop/terraform`) that is NOT in
> the delivered package, and `make agent-e2e` is a **lab** Makefile target, also
> not shipped. For the DC in-cluster path, use the verification in
> **[../../../docs/customer-install/04b-deploy-data-center-in-cluster.md → Step 6](../../../docs/customer-install/04b-deploy-data-center-in-cluster.md)**
> (in-cluster reachability + a signed test POST + the real-ticket dry run) instead.

## Run it (Cloud / lab only)

```bash
# from the repo root of the FULL lab repo, kubectl pointed at the cluster:
make agent-e2e             # full run, stop on first failure
make agent-e2e-step        # step-by-step: explains + pauses before each stage

# or directly (set TF_DIR to wherever the CloudFront URL output lives):
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
| 0 | Create ticket | creates a **fresh** Jira ticket each run (so you see new tickets + comments every time) |
| 1 | Health through CloudFront | `GET /healthz`+`/readyz` = 200 → CF → NLB → receiver is up |
| 2 | Origin lock | a direct hit to the NLB (bypassing CloudFront) is refused |
| 3 | Auth | a bad-signature webhook is rejected `401` (auth runs before parse/gate) |
| 4 | Eligibility gate | a valid-but-ineligible event is dropped `200` with **no** Job |
| 5 | Spawn | a real `automation:label-added` event creates exactly one run Job |
| 6 | Dedupe | re-sending the same delivery id creates **no** second Job (409) |
| 7 | Concurrency quota | the ResourceQuota uses the non-terminal `pods` key, not `count/pods` |
| 8 | Run completes | the Job finishes and a fresh audit comment lands on the new ticket **in real Jira** (comment count grew) |

## Configuration

All optional — defaults are auto-discovered from terraform + the cluster:

| Env | Default | Meaning |
|---|---|---|
| `WEBHOOK_URL` | `terraform output triage_webhook_url` | the CloudFront webhook URL to drive |
| `TF_DIR` | `workshop/terraform` | terraform dir to read the URL output from |
| `NS` | `agents` | the agent namespace |
| `E2E_ISSUE_KEY` | *(empty)* | empty → **create a fresh ticket each run** (default). Set it to pin/reuse a fixed ticket. |
| `E2E_PROJECT` | `KAN` | project to create the fresh ticket in |
| `E2E_CREATE_TICKET` | `1` | `1` create fresh (default), `0` reuse `E2E_ISSUE_KEY` |
| `E2E_ACTOR_ID` | first `AUTHORIZED_ACTORS` id on the receiver | the authorized triggering actor |
| `JIRA_BASE_URL` | from the receiver's `RUN_ENV` | Jira site for create + verify |
| `WAIT_RUN` | `300` | seconds to wait for the run in stage 8 (`0` = don't wait) |

By default each run **creates a new ticket** (stage 0) so you always get fresh
tickets and comments. The Jira creds, auth secrets, and the actor id are read
**read-only** from the live deployment (`agents/agent-secrets`, the receiver env)
so the create + signed webhooks are valid against it — nothing is hardcoded.

To repeatedly hit one ticket instead: `E2E_ISSUE_KEY=KAN-2 make agent-e2e`.

## Safety

Read-mostly against the cluster and Jira. The only writes are:

- Creating a fresh synthetic ticket in `E2E_PROJECT` (a self-labelled "E2E test"
  Task) — and the triage run then comments/labels **that** ticket. Runs against
  a throwaway project; the tickets are clearly marked and safe to bulk-close.
- POSTing synthetic webhooks to the receiver, which spawn the run Job.
- Deleting the run Job the test created, during cleanup.

It never edits the manifests, the terraform, or any cluster config. (It does not
delete the test tickets — they accumulate in the project as a visible run log;
clean them up in Jira when you like.)
