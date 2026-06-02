# agent/ — the shippable Jira triage agent

This directory is the **complete, self-contained unit** deployed into a
Kubernetes cluster. Nothing under `workshop/` is required to run it.

```
listener/                Node HTTP listener (zero deps): auth, gating, spawns pi runs
  src/{server,gate,limits}.js
  test/                  node:test suite (run: cd listener && node --test)
skills/jira-triage/      pi.dev skill: SKILL.md rubric + jira.sh / gitlab.sh
docker/triage/Dockerfile linux/amd64 image (listener + pi + skill); build context is THIS dir
k8s/                     namespace/SA, listener Deployment+LB, NetworkPolicy, config/secret
terraform/               standalone IRSA + optional CloudFront for an EXISTING cluster
```

## Install

Full step-by-step: **[../docs/customer-install/](../docs/customer-install/)**.

Short version:

```bash
# 1. cloud deps (against your existing cluster's OIDC provider)
cd agent/terraform && cp example.tfvars terraform.tfvars   # edit, then:
terraform init && terraform apply

# 2. image
docker buildx build --platform linux/amd64 -f agent/docker/triage/Dockerfile \
  -t <repo>/triage-agent:latest --push agent

# 3. config + secrets (fill the .example templates), set the SA role ARN,
#    image, JIRA_BASE_URL, GITLAB_BASE_URL, AUTHORIZED_ACTORS, then:
kubectl apply -f agent/k8s/

# 4. wire CloudFront + register the Jira trigger (see the install guide)
```

## Build / test

```bash
cd agent/listener && node --test     # listener unit + integration tests
bash agent/skills/jira-triage/tests/run.sh   # skill script tests
```

See [../docs/architecture/](../docs/architecture/) for how the pieces fit and the
trust model.
