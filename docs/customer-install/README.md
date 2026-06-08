# Customer Install — Jira Triage Agent

Install the triage agent into an EKS cluster you **already operate**, against
your **existing** GitLab and Jira. This installs only the shippable unit under
`agent/` — it does **not** create a cluster, a VPC, or GitLab.

Clone the repo, then run everything from its root:

```bash
git clone <repo-url> && cd <repo>
```

## Start here → [00 — Complete Guide](00-COMPLETE-GUIDE.md)

**One document, start to finish.** It takes you from nothing to a working
end-to-end triage — AWS/Bedrock, EKS, ECR, the image, GitLab, Jira, the
manifests, and verification. Follow it top to bottom; **you don't need any other
page to install.**

It's written for the common case: **Jira Data Center running in the same
cluster**, no internet exposure. If that's you, the Complete Guide is the whole
job.

## What you'll deploy

- A thin, stateless **receiver** that creates **one Kubernetes Job per event**
  (no long-lived runner — K8s handles dedupe, concurrency, timeout, retry).
- An **IRSA role** scoped to one Bedrock model (no static model credential).
- The **`agents` namespace**: two ServiceAccounts, RBAC, a ResourceQuota
  (concurrency), a NetworkPolicy, ConfigMap, and Secret.

The agent triggers when someone adds the `triage` label to a Jira ticket.

## Prerequisites at a glance

- An existing **EKS cluster** with an **IAM OIDC provider** (for IRSA).
- **Amazon Bedrock** model access in the cluster's region.
- An **ECR repo** (or any registry the cluster can pull from).
- **Jira** (Data Center or Cloud) — permission to create a bot user + the trigger.
- A **GitLab** instance the cluster can reach, and a read-only token.
- `kubectl`, `docker` (buildx), `aws` CLI, `jq`, `openssl` on PATH.

Full detail: [01 — Prerequisites](01-prerequisites.md).

---

## Reference pages (deep-dives)

The Complete Guide links to these where useful. **Read them only if you want more
depth on one step** — you do not follow them in sequence.

| Page | When you'd open it |
|---|---|
| [01 — Prerequisites](01-prerequisites.md) | Full prereq detail + reading your cluster's OIDC provider. |
| [02 — Configure GitLab](02-configure-gitlab.md) | Read-only token, reachability, CODEOWNERS routing. |
| [03 — Configure Jira (Data Center)](03-configure-jira-data-center.md) | The DC admin deep-dive: bot user, PAT, allowed values, trigger (System Webhook vs Automation rule, with the DC signing caveat). |
| [04b — Deploy: Jira DC, in-cluster](04b-deploy-data-center-in-cluster.md) | The DC deploy deep-dive: ClusterIP receiver, `TRIGGER=jira-dc`, ingress NetworkPolicy. |
| [05 — Operations](05-operations.md) | Verify, monitor, rotate credentials, tune cost, troubleshoot. |
| [06 — Security](06-security.md) | The trust model and what to confirm in your environment. |
| [07 — Authoring agents](07-authoring-agents.md) | The runner is generic; `SKILL.md` frontmatter defines the agent. Write a new one without touching code. |
| [Configure & change the prompt](GUIDE-configure-and-change-the-prompt.md) | The two change speeds: fast (`kubectl apply`) vs. rebuild (bump the image tag). |
| [03b — Choose your harness](03b-choose-harness.md) | Pick the coding-agent CLI (pi / kiro-cli / opencode) and how it authenticates to its model. Optional — defaults to pi on Bedrock via IRSA. |

## Jira Cloud instead of Data Center?

The agent supports Jira Cloud too (Automation rule + a public HTTPS endpoint via
CloudFront or your own ALB). This is the **secondary** path — the Complete Guide
covers DC in-cluster. For Cloud, use these two instead of the DC pages:

- [03 — Configure Jira (Cloud + DC)](03-configure-jira.md) — the Cloud Automation-rule trigger.
- [04 — Deploy the agent (CloudFront/ALB)](04-deploy-agent.md) — public webhook endpoint.

Everything else (image build, IRSA, manifests, operations, security) is the same.

## How it works (one paragraph)

Adding the `triage` label fires an HTTP request from Jira to the receiver. The
receiver authenticates it (HMAC for system webhooks, or a shared-secret header
for Automation rules), applies a stack of guards (loop guard, actor allowlist,
dedupe, rate + daily-spend limits), acks fast, and spawns one headless agent run.
That run reads the ticket and the relevant GitLab source (read-only), classifies
it, writes back fields + an audit comment within an allow-listed value set, and
removes the `triage` label. See [Architecture](../architecture/README.md) for
diagrams and the full trust model.
