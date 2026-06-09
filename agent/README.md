# agent/ — the shippable agent runner

The **complete, self-contained unit** deployed into a Kubernetes cluster you
already operate. `kubectl` + `docker` + (on EKS) one small `aws` CLI script —
nothing else to stand up. It's organized as three concerns:

```
runtime/                 THE ENGINE — trigger × agent × harness
  receiver.js            stateless webhook front: auth → decide → create one Job → ack
  run.js                 one-shot Job entrypoint: render prompt → spawn harness → exit
  lib/                   auth.js, agent-def.js, job.js (manifest), k8s.js (createJob)
  trigger/               trigger adapters (jira, jira-dc, generic, + your own)
  harness/               harness adapters (pi, kiro-cli, opencode, + your own)
  test/                  node:test suite  (run: cd runtime && node --test)

agents/                  THE IMPLEMENTATIONS — one dir per agent, each with its
  jira-triage-dc/          own Dockerfile (one agent per image, isolated)
    SKILL.md  scripts/  Dockerfile
  <your-agent>/          ← a code-review agent goes HERE, as its own dir

deploy/                  HOW IT SHIPS
  docker/                base.Dockerfile (engine) + pi/kiro/opencode (harness bases)
  k8s/base/              namespace + 2 SAs, rbac, resourcequota, netpol,
                         ingress-netpol, receiver (ClusterIP), config/secret
  k8s/overlays/          eks-bedrock (keyless IRSA) · vanilla (static key)
```

**Where does a new agent (e.g. code-review) go?** A new directory under
`agents/`, with its own `SKILL.md` whose frontmatter declares the prompt that
drives it. No engine code changes — point `AGENT_PATH` at it. See
[../docs/customer-install/07-authoring-agents.md](../docs/customer-install/07-authoring-agents.md).

**Three pluggable axes** (all default to jira / jira-triage / pi):
- **trigger** (`TRIGGER` env) — how the webhook is authed/parsed/gated.
- **agent** (`AGENT_PATH`) — *what the agent is*, defined by a dir under `agents/`.
- **harness** (`HARNESS` env) — which coding-agent CLI runs the prompt.

See [runtime/harness/README.md](runtime/harness/README.md) and
[../docs/customer-install/03b-choose-harness.md](../docs/customer-install/03b-choose-harness.md).

## Install

**Full start-to-finish guide:
[../docs/customer-install/00-COMPLETE-GUIDE.md](../docs/customer-install/00-COMPLETE-GUIDE.md)**
(AWS/Bedrock, image → registry, GitLab, Jira DC, manifests, verification).

This directory has a self-contained `Makefile` — run from here (`cd agent`):

```bash
# 1. (EKS) create the one IAM role for Bedrock — a small AWS CLI script
CLUSTER=<cluster> REGION=eu-west-1 deploy/k8s/overlays/eks-bedrock/irsa-bedrock.sh

# 2. build + push the image (any registry — Nexus, ECR, Harbor, …)
docker login <registry-host>
make agent-image AGENT=jira-triage-dc HARNESS=pi REGISTRY=<host>/<repo>

# 3. fill the templates (deploy/k8s/base/{config,secrets}.example.yaml → .yaml),
#    set image/AUTHORIZED_ACTORS/GITLAB_BASE_URL in base/receiver.yaml + the
#    SA role ARN in overlays/eks-bedrock/sa-irsa-patch.yaml, then:
make agent-deploy OVERLAY=eks-bedrock

# 4. register the Jira trigger (see the install guide)
```

Targets and which manifests apply per cluster: [deploy/k8s/](deploy/k8s/) and
[../docs/customer-install/deploy-targets.md](../docs/customer-install/deploy-targets.md).

## Build / test

```bash
cd agent/runtime && node --test                 # runtime unit + integration tests
bash agent/agents/jira-triage-dc/tests/run.sh   # skill script tests
#   …or, from agent/:  make test
```
