# Customer Install — Jira Triage Agent

Install the triage agent into an EKS cluster you **already operate**, against
your **existing** GitLab and Jira. This guide deploys only the shippable unit
under `agent/` — it does **not** create a cluster, a VPC, or GitLab (that's the
[workshop lab](../workshop/), which exists only to develop the agent).

## What you'll deploy

- A **listener** pod (single replica) behind a dedicated LoadBalancer.
- A public HTTPS webhook endpoint — via **CloudFront** (no domain needed) or your
  own ALB + domain + TLS.
- An **IRSA role** scoped to one Bedrock model (no static model credential).
- A pluggable **coding-agent harness** — **pi** (Bedrock via IRSA) or
  **kiro-cli** (its own backend), or bring your own. See
  [Choose your harness](03b-choose-harness.md).
- The **`triage` namespace**: ServiceAccount, NetworkPolicy, ConfigMap, Secret.

The agent then triggers when someone adds the `triage` label to a Jira ticket.

## Prerequisites at a glance

- An existing **EKS cluster** with an **IAM OIDC provider** enabled (for IRSA).
- **Amazon Bedrock** model access in the cluster's region.
- An **ECR repo** (or any registry the cluster can pull from).
- **Jira** (Cloud or Data Center) with permission to create a bot user + the
  trigger (Automation rule or system webhook).
- A **GitLab** instance the cluster can reach, and a read-only token.
- `kubectl`, `terraform` (>= 1.5), `docker` (buildx), `aws` CLI on PATH.

Full detail: **[01 — Prerequisites](01-prerequisites.md)**.

## Install order

Do these in sequence. Each page ends by pointing at the next.

1. **[Prerequisites](01-prerequisites.md)** — what must exist before you start, and how to read your cluster's OIDC provider.
2. **[Configure GitLab](02-configure-gitlab.md)** — read-only token, reachability from the cluster, CODEOWNERS for routing.
3. **[Configure Jira](03-configure-jira.md)** — bot account + token, allowed-value sets, and the trigger. **Covers both Jira Cloud (Automation rule) and Data Center / Server (HMAC webhook).**
3b. **[Choose your harness](03b-choose-harness.md)** — pick the coding-agent CLI the agent runs on (**pi** or **kiro-cli**, or bring your own). Optional — defaults to pi.
4. **[Deploy the agent](04-deploy-agent.md)** — terraform (IRSA + CloudFront), build/push the image, fill in manifests, `kubectl apply`, lock the origin, run the pre-launch checklist.
5. **[Operations](05-operations.md)** — verify, monitor, rotate credentials, tune cost, troubleshoot.
6. **[Security](06-security.md)** — the trust model and what you must confirm in your environment.

## How it works (one paragraph)

Adding the `triage` label fires an outbound HTTP request from Jira to your
webhook URL. The listener authenticates it (HMAC for system webhooks, or a
shared-secret header for Cloud Automation rules), applies a stack of guards
(loop guard, actor allowlist, dedupe, rate + daily-spend limits), acks fast, and
spawns one headless `pi` run. That run reads the ticket and the relevant GitLab
source (read-only), classifies it, writes back fields + an audit comment within
an allow-listed value set, and removes the `triage` label. See
[Architecture](../architecture/README.md) for diagrams and the full trust model.
