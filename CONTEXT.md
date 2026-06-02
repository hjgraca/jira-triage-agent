# Context — Jira Triage Agent

Glossary of the domain language for this project. Terms only; no implementation
details. See `docs/` for plans/brainstorms and the HLD for the customer-facing
design.

## Terms

### Triage agent

The autonomous unit being delivered: a one-shot [[pi]] run that classifies a
single Jira ticket (category, state, severity), and — for low/medium tickets —
writes bounded fields and an audit comment. High-severity tickets get a
`needs-human` label and a recommendation only. It is the **only thing we
deploy**; the cluster, GitLab, and Jira already exist in the customer's estate.

### Listener

The always-on in-cluster service that receives Jira webhooks, authenticates and
gates them, and spawns one triage-agent run per eligible ticket. Distinct from
the agent: the listener is long-running; the agent is short-lived.

### Deploy locus

Where we deploy: the **customer's existing EKS cluster**, as a new `triage`
namespace alongside their GitLab. We do not provision the cluster, GitLab, or
Jira. IRSA binds the customer cluster's OIDC provider; GitLab is reached over
in-cluster Service DNS; Bedrock runs in the customer's AWS account.

### Jira (Data Center)

The customer runs **Jira Data Center (self-hosted)**, NOT Jira Cloud. It sits on
a **private network routable to the cluster VPC**, so the webhook reaches an
**internal** LoadBalancer — there is no public ingress, no CloudFront, no
internet exposure. (The repo's current code is Jira-Cloud-shaped; the HLD
documents the Data Center target and the deltas.)

### Webhook trigger

The customer-owned Jira-side configuration that POSTs to the listener on issue
creation or `triage`-label add. Authenticated by a shared secret; reachable only
over the internal network. Exact mechanism is confirmed with the customer's Jira
admins — out of scope for what we deploy.

### Triage bot account

The dedicated Jira identity the agent acts as (comments, field writes). Its
identity is what the listener's loop guard keys on to suppress the agent's own
writes from re-triggering a run.

### pi

The pi.dev coding harness the agent is built on; runs headless (`--mode json`),
authenticates to Bedrock via IRSA, loads the triage rubric as a skill.
