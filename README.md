# Jira Triage Agent

An autonomous **Jira triage agent** built on the [pi.dev](https://github.com/earendil-works/pi)
coding harness. It installs into a Kubernetes cluster you **already operate** —
`kubectl` + `docker`, plus (on EKS) one small `aws` CLI script for the Bedrock IAM
role. Nothing else to stand up.

The default agent watches for a `triage` label on a Jira ticket, reads the ticket
and the relevant GitLab source (read-only), classifies it (category / state /
severity), sets fields within an allow-listed set, posts an audit comment, and —
for multi-repo features — proposes a work split across teams.

Under the hood: a thin, stateless **receiver** authenticates + gates each webhook
and creates **one Kubernetes Job per event** (Kubernetes provides dedupe,
concurrency, timeout, retry — no long-lived stateful runner). The engine is
**trigger × agent × harness**, all pluggable:

- **trigger** — how an event is authenticated, parsed, and gated (`jira-dc` for
  Jira Data Center, `jira` for Cloud, or a `generic` signed POST).
- **agent** — *what the agent is*, defined by the **skill's `SKILL.md`
  frontmatter** (its prompt, rubric, tools). Point at a different agent dir → a
  different agent, no code change. See [authoring agents](docs/customer-install/07-authoring-agents.md).
- **harness** — the coding-agent CLI that runs it:
  [pi.dev](https://github.com/earendil-works/pi) (Bedrock via IRSA),
  [kiro-cli](https://kiro.dev), or [opencode](https://opencode.ai), or bring your
  own (see [harness adapters](agent/runtime/harness/README.md)).

See [Architecture](docs/architecture/) for the runtime model and trust diagram.

---

## Install

**Start here → [docs/customer-install/00-COMPLETE-GUIDE.md](docs/customer-install/00-COMPLETE-GUIDE.md)**
— one document, start to finish (Jira DC, in-cluster): AWS/Bedrock, the image →
your registry, GitLab, Jira DC, the manifests, and verification. Everything else
under [docs/customer-install/](docs/customer-install/) is a per-topic deep-dive it
links to.

The agent is **four independent choices** — input (`jira-dc`/`jira`/`generic`),
harness (`pi`/`kiro-cli`/`opencode`), deploy target (any Kubernetes; EKS gets
keyless Bedrock), and registry (Nexus/ECR/Harbor/…). Mix and match; see the
[customer-install README](docs/customer-install/README.md) for the per-axis pages.

---

## Repository layout

```
agent/                      THE SHIPPABLE UNIT — deploy this into a cluster you operate
  Makefile                  make agent-image | test | agent-deploy  (run from agent/)
  runtime/                  Engine (Node, zero deps): receiver.js + run.js + lib/
                            + trigger/ + harness/ (the two entrypoints + adapters)
  agents/jira-triage-dc/    One agent: SKILL.md (def + rubric) + jira.sh/gitlab.sh + Dockerfile
  deploy/docker/            base + per-harness Dockerfiles (engine → CLI → agent)
  deploy/k8s/base/          receiver (ClusterIP), RBAC, ResourceQuota, NetworkPolicy, config/secret
  deploy/k8s/overlays/      eks-bedrock (keyless IRSA) · vanilla (static model key)

docs/
  architecture/             Diagrams + trust model
  customer-install/         Step-by-step agent install for a cluster you already run
  decisions/                Architecture decision records
```

## Status

The agent is built and tested end-to-end: a `triage` label added in Jira triggers
a real run that reads both a frontend and a backend GitLab repo, classifies the
ticket, comments, and clears the label — with every guardrail (auth, loop guard,
actor allowlist, allowed-value gate, verify-before-write, spend budget) exercised.
See [docs/architecture/](docs/architecture/) for the trust model.
