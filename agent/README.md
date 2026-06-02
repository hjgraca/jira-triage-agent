# agent/ — the shippable agent runner

The **complete, self-contained unit** deployed into a Kubernetes cluster.
Nothing under `workshop/` is required to run it. It's organized as three concerns:

```
runtime/                 THE ENGINE — generic trigger × agent × harness runner
  listener/              server.js + agent-def.js + auth.js + limits.js + gate.js
  trigger/               trigger adapters (jira, generic, + your own)
  harness/               harness adapters (pi, kiro-cli, opencode, + your own)
  test/                  node:test suite  (run: cd runtime && node --test)

agents/                  THE IMPLEMENTATIONS — one dir per agent
  jira-triage/           SKILL.md (frontmatter = agent def + rubric) + scripts/
  <your-agent>/          ← a code-review agent goes HERE, as its own dir

deploy/                  HOW IT SHIPS
  docker/                base.Dockerfile + pi/kiro/opencode .Dockerfiles
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

# 2. image — shared base, then the harness you want
docker buildx build --platform linux/amd64 \
  -f agent/deploy/docker/base.Dockerfile -t triage-base:local --load agent
docker buildx build --platform linux/amd64 \
  -f agent/deploy/docker/pi.Dockerfile --build-arg BASE=triage-base:local \
  -t <repo>/triage-agent:latest --push agent

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
