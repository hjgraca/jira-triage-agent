# agent/ — the shippable agent runner

The **complete, self-contained unit** deployed into a Kubernetes cluster.
Nothing under `workshop/` is required to run it. It's organized as three concerns:

```
runtime/                 THE ENGINE — generic trigger × agent × harness runner
  listener/              server.js (HTTP + gate wiring) + runner.js (run lifecycle)
                         + agent-def.js + auth.js + limits.js
  trigger/               trigger adapters (jira, generic, + your own)
  harness/               harness adapters (pi, kiro-cli, opencode, + your own)
  test/                  node:test suite  (run: cd runtime && node --test)

agents/                  THE IMPLEMENTATIONS — one dir per agent, each with its
  jira-triage/             own Dockerfile (one agent per image, isolated)
    SKILL.md  scripts/  Dockerfile
  <your-agent>/          ← a code-review agent goes HERE, as its own dir

deploy/                  HOW IT SHIPS
  docker/                base.Dockerfile (engine) + pi/kiro/opencode (harness bases)
  k8s/                   namespace/SA, listener Deployment+LB, NetworkPolicy, config/secret
  terraform/             standalone IRSA + optional CloudFront for an EXISTING cluster
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

Full step-by-step: **[../docs/customer-install/](../docs/customer-install/)**.

Short version:

```bash
# 1. cloud deps (against your existing cluster's OIDC provider)
cd agent/deploy/terraform && cp example.tfvars terraform.tfvars   # edit, then:
terraform init && terraform apply

# 2. image — three layers: base (engine) → harness (CLI) → agent (one agent)
make triage-image AGENT=jira-triage HARNESS=pi
#   …or raw:
#   docker build -f agent/deploy/docker/base.Dockerfile  -t triage-base:local       agent
#   docker build -f agent/deploy/docker/pi.Dockerfile    --build-arg BASE=triage-base:local -t triage-pi:local agent
#   docker build -f agent/agents/jira-triage/Dockerfile  --build-arg BASE=triage-pi:local   -t <repo>:latest  agent

# 3. config + secrets (fill the .example templates), set the SA role ARN,
#    image, JIRA_BASE_URL, GITLAB_BASE_URL, AUTHORIZED_ACTORS, then:
kubectl apply -f agent/deploy/k8s/

# 4. wire CloudFront + register the Jira trigger (see the install guide)
```

## Build / test

```bash
cd agent/runtime && node --test              # runtime unit + integration tests
bash agent/agents/jira-triage/tests/run.sh   # skill script tests
```

See [../docs/architecture/](../docs/architecture/) for how the pieces fit and the
trust model.
