# Customer Install — Triage Agent

Install the triage agent into a Kubernetes cluster you **already operate**,
against your **existing** issue tracker and source host. It does **not** create a
cluster, a VPC, or your tracker/source. Clone the repo and run from its root:

```bash
git clone <repo-url> && cd <repo>
```

## Plug-and-play: pick one from each axis

The agent is four independent choices. Mix and match — every combination works,
because the engine treats each axis as a plugin:

| Axis | Options | Where |
|---|---|---|
| **Input** (what triggers a run) | `jira-dc` · `jira` (Cloud) · `generic` signed POST · *write your own* | [inputs](#input--what-triggers-a-run) |
| **Harness** (the coding agent) | `pi` · `kiro-cli` · `opencode` · *BYO* | [03b — Choose your harness](03b-choose-harness.md) |
| **Deploy target** (the cluster) | EKS · GKE · AKS · on-prem · kind — **any Kubernetes** | [deploy-targets](deploy-targets.md) |
| **Registry** (the image home) | ECR · Nexus · Harbor · GHCR · Docker Hub · self-hosted | [registries](#registry) |

You set the **input** and **harness** via one env line (`TRIGGER=…`, `RUN_ENV
HARNESS=…`) in `receiver.yaml`; the **deploy target** picks which `overlays/`
folder you apply on top of `base/`; the **registry** is just where you push the
image (`REGISTRY=…`). Nothing is hard-wired to AWS except the optional keyless
Bedrock overlay.

> **The base is portable.** `deploy/k8s/base/` runs on any Kubernetes and exposes
> the receiver as an in-cluster `ClusterIP` (the input source posts to it over
> cluster DNS). The only cloud-specific piece is the `eks-bedrock` overlay
> (keyless model auth on EKS); on any other cluster you apply `base/` + a static
> model key and you're done. Need to accept a webhook from outside the cluster?
> Put your own Ingress/LoadBalancer + TLS in front of the Service — orthogonal to
> everything here.

## Start here → [00 — Complete Guide](00-COMPLETE-GUIDE.md)

A **worked end-to-end example** for the most common combination — **input
`jira-dc` × harness `pi` × deploy EKS (keyless Bedrock) × any registry** — from
nothing to a working triage, top to bottom. If that's your stack, it's the whole
job. For a different combination, follow it and swap the axis that differs using
the per-axis pages below.

## The axes in detail

### Input — what triggers a run

A run starts from one signed HTTP POST. The **trigger adapter** (`TRIGGER` env)
parses + authenticates it; adapters live in `agent/runtime/trigger/`:

| `TRIGGER` | Source | Auth | Actor keyed on |
|---|---|---|---|
| `jira-dc` | Jira Data Center / Server | HMAC (`X-Hub-Signature`) or shared-secret header | `user.name` / `user.key` |
| `jira` | Jira Cloud | Automation-rule shared secret, or HMAC | `accountId` |
| `generic` | any system that can POST + sign | HMAC | configurable |

GitHub or another tracker: add one adapter file (parse + `dedupeId` + actor) — see
[07 — Authoring agents](07-authoring-agents.md). The agent *definition* (rubric,
allowed values) is separate from the input adapter, so one agent can serve any.

### Harness

The coding-agent CLI each run spawns — `pi`, `kiro-cli`, or `opencode`, or BYO.
This axis also decides **model auth** (keyless on EKS vs. a static key elsewhere).
Full table + setup: [03b — Choose your harness](03b-choose-harness.md).

### Deploy target

Any Kubernetes cluster. `base/` is portable; an `overlays/` folder supplies the
cluster-specific identity/ingress. Full matrix: [deploy-targets](deploy-targets.md).

### Registry

Any registry the cluster can pull from. The image ref is a plain string in the
manifests and the build takes `REGISTRY=<host>/<repo>`. Private registries
(Nexus/Harbor) use a `docker-registry` pull secret wired via `imagePullSecrets` /
`IMAGE_PULL_SECRET` — see [01 — Prerequisites §3](01-prerequisites.md). ECR via the
node role needs none.

---

## Reference pages

| Page | When you'd open it |
|---|---|
| [01 — Prerequisites](01-prerequisites.md) | Cluster/OIDC, registry, Bedrock access, tooling. |
| [02 — Configure GitLab](02-configure-gitlab.md) | Read-only token, reachability, CODEOWNERS routing. |
| [03 — Configure Jira (Data Center)](03-configure-jira-data-center.md) | DC admin deep-dive: bot user, PAT, allowed values, the trigger. |
| [03b — Choose your harness](03b-choose-harness.md) | Harness × model-auth axis. |
| [deploy-targets](deploy-targets.md) | Deploy-target axis: EKS / GKE / AKS / on-prem / kind. |
| [04b — Deploy (in-cluster)](04b-deploy-data-center-in-cluster.md) | The in-cluster ClusterIP deploy, step by step. |
| [05 — Operations](05-operations.md) | Verify, monitor, rotate credentials, tune cost, troubleshoot. |
| [06 — Security](06-security.md) | Trust model and what to confirm in your environment. |
| [07 — Authoring agents](07-authoring-agents.md) | Write a new agent/input without touching engine code. |
| [Configure & change the prompt](GUIDE-configure-and-change-the-prompt.md) | Fast (`kubectl apply`) vs. rebuild change loops. |

## How it works (one paragraph)

A signed HTTP POST from your input source hits the receiver. The receiver
authenticates it, applies a stack of guards (loop guard, actor allowlist, dedupe,
rate + spend limits), acks fast, and creates **one Kubernetes Job** for the run.
That Job spawns the harness, which reads the ticket and the relevant source
(read-only), classifies it, writes back fields + an audit comment within an
allow-listed value set, and clears the trigger label. The receiver is stateless;
Kubernetes provides dedupe, concurrency, timeout, and retry. See
[Architecture](../architecture/README.md) for diagrams and the full trust model.
