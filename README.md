# Jira Triage Agent — Workshop & Customer Install

An autonomous **Jira triage agent** built on the [pi.dev](https://github.com/earendil-works/pi)
coding harness, plus the EKS **workshop lab** used to develop and demo it.

The default agent watches for a `triage` label on a Jira ticket, reads the ticket
and the relevant GitLab source, classifies it (category / state / severity), sets
fields within an allow-listed set, posts an audit comment, and — for multi-repo
features — proposes a work split across teams.

Under the hood: a thin, stateless **receiver** authenticates + gates each webhook
and creates **one Kubernetes Job per event** (Kubernetes provides dedupe,
concurrency, timeout, retry — no long-lived stateful runner). The engine is
**trigger × agent × harness**, all pluggable:

- **trigger** — how an event is authenticated, parsed, and gated (`jira` webhook,
  or a `generic` signed POST).
- **agent** — *what the agent is*, defined by the **skill's `SKILL.md`
  frontmatter** (its prompt, rubric, tools). Point at a different agent dir → a
  different agent, no code change. See [authoring agents](docs/customer-install/07-authoring-agents.md).
- **harness** — the coding-agent CLI that runs it:
  [pi.dev](https://github.com/earendil-works/pi) (Bedrock via IRSA),
  [kiro-cli](https://kiro.dev), or [opencode](https://opencode.ai), or bring your
  own (see [harness adapters](agent/runtime/harness/README.md)).

See [Architecture](docs/architecture/) for the runtime model and trust diagram.

---

## Two audiences — start in the right place

This repo serves two distinct purposes. Pick the one you're here for:

| You want to… | Go to | What it covers |
|---|---|---|
| **Install the agent** into an existing cluster (a customer's, or your own) | **[docs/customer-install/](docs/customer-install/)** | The shippable unit only: `agent/` (engine + skill + image + manifests) and `agent/deploy/terraform` (IRSA + optional CloudFront) against a cluster you already run. |
| **Stand up the full lab** (EKS + self-hosted GitLab + the agent) to develop or demo | **[docs/workshop/](docs/workshop/)** | The whole environment: `workshop/terraform` (VPC + EKS), GitLab via Helm, then the agent on top. Driven by the `Makefile`. |
| **Understand how it works** | **[docs/architecture/](docs/architecture/)** | Topology and request-flow diagrams for both the workshop and the customer (agent-only) deployments, plus the trust/security model. |

> **The boundary in one line:** everything under **`agent/`** is what ships to a
> customer. Everything under **`workshop/`** is the lab that exists only to
> exercise it. The customer never applies `workshop/terraform` or installs GitLab
> from this repo — they bring their own cluster and their own source host.

---

## Repository layout

```
agent/                      THE SHIPPABLE UNIT — deploy this into any EKS cluster
  runtime/                  Engine (Node, zero deps): receiver.js + run.js + lib/
                            + trigger/ + harness/ (the two entrypoints + adapters)
  agents/jira-triage/       One agent: SKILL.md (def + rubric) + jira.sh/gitlab.sh + Dockerfile
  deploy/docker/            base + per-harness Dockerfiles (engine → CLI → agent)
  deploy/k8s/               receiver Deployment, RBAC, ResourceQuota, NetworkPolicy, config/secret
  deploy/terraform/         Standalone IRSA + optional CloudFront for a customer's cluster

workshop/                   THE LAB — only needed to develop/demo the agent
  terraform/                VPC + EKS cluster, Bedrock IRSA, CloudFront (all-in-one state)
  helm/gitlab-values.yaml   Self-hosted GitLab values
  k8s/gitlab-shell-ssh-lb.yaml   IP-locked SSH LoadBalancer for GitLab

docs/
  architecture/             Diagrams + trust model
  workshop/                 Lab bring-up guide
  customer-install/         Step-by-step agent install for an existing cluster

Makefile                    Workshop orchestration (cluster -> kubeconfig -> apps)
```

## Quick links

- **Customer install:** [Prerequisites](docs/customer-install/01-prerequisites.md) ·
  [GitLab](docs/customer-install/02-configure-gitlab.md) ·
  [Jira](docs/customer-install/03-configure-jira.md) ·
  [Deploy](docs/customer-install/04-deploy-agent.md) ·
  [Operations](docs/customer-install/05-operations.md) ·
  [Security](docs/customer-install/06-security.md)
- **Workshop lab:** [docs/workshop/](docs/workshop/)
- **Architecture & diagrams:** [docs/architecture/](docs/architecture/)

## Status

The agent is built, deployed, and proven end-to-end in a test environment: a
`triage` label added in Jira triggers a real run that reads both a frontend and a
backend GitLab repo, classifies the ticket, comments, and clears the label — with
every guardrail (auth, loop guard, actor allowlist, allowed-value gate,
verify-before-write, spend budget) exercised. See
[docs/architecture/](docs/architecture/) for the trust model.
