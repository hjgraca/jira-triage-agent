# Jira Triage Agent — Workshop & Customer Install

An autonomous **Jira triage agent** built on the [pi.dev](https://github.com/earendil-works/pi)
coding harness, plus the EKS **workshop lab** used to develop and demo it.

The agent watches for a `triage` label on a Jira ticket, reads the ticket and the
relevant GitLab source, classifies it (category / state / severity), sets fields
within an allow-listed set, posts an audit comment, and — for multi-repo
features — proposes a work split across teams. It runs headless in Kubernetes and
calls Amazon Bedrock via IRSA (no static model credential).

---

## Two audiences — start in the right place

This repo serves two distinct purposes. Pick the one you're here for:

| You want to… | Go to | What it covers |
|---|---|---|
| **Install the agent** into an existing cluster (a customer's, or your own) | **[docs/customer-install/](docs/customer-install/)** | The shippable unit only: `agent/` (listener + skill + image + manifests) and `agent/terraform` (IRSA + optional CloudFront) against a cluster you already run. |
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
  listener/                 Webhook listener (Node, zero deps) that gates + spawns runs
  skills/jira-triage/       pi.dev skill: triage rubric (SKILL.md) + jira.sh / gitlab.sh
  docker/triage/Dockerfile  Container image (listener + pi + skill)
  k8s/                      Namespace/SA, listener Deployment+LB, NetworkPolicy, config/secrets
  terraform/                Standalone IRSA + optional CloudFront for a customer's cluster

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
