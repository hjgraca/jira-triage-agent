# 04 — Deploy the Agent

> **Running Jira Data Center, in-cluster?** Use
> **[04b — Deploy: DC in-cluster](04b-deploy-data-center-in-cluster.md)** instead —
> it's `kubectl` + one script, no Terraform, no CloudFront. This page (04) is the
> **Cloud / public-ingress** path. Also note: `make agent-deploy` /
> `../workshop/…` referenced below are **lab** conveniences (the repo-root
> `Makefile`); for install, use the agent's own `agent/Makefile`, which has
> `agent-image`, `test`, and `agent-deploy-dc`.

Provision the cloud dependencies, build the image, fill in the manifests, apply,
lock the webhook origin, and run the pre-launch checklist. This is the
customer-cluster path (uses `agent/deploy/terraform` against your existing cluster). In
the workshop lab, the `Makefile` shortcuts some of this — see
[workshop](../workshop/README.md#deploying-the-agent-in-the-lab).

← [Configure Jira](03-configure-jira.md) · Next → [Operations](05-operations.md)

---

## Step 1 — Provision IRSA (and optionally CloudFront)

`agent/deploy/terraform` creates the Bedrock IRSA role bound to **your existing
cluster's** OIDC provider, and (optionally) a CloudFront distribution for the
webhook.

```bash
cd agent/deploy/terraform
cp example.tfvars terraform.tfvars        # then edit it
```

Fill `terraform.tfvars` with the values from
[Prerequisites](01-prerequisites.md):

```hcl
name              = "acme-prod"
region            = "eu-west-1"
oidc_provider_arn = "arn:aws:iam::111122223333:oidc-provider/oidc.eks.eu-west-1.amazonaws.com/id/EXAMPLE..."
# bedrock_model_id = "eu.anthropic.claude-sonnet-4-6"   # MUST match MODEL/AWS_REGION in receiver.yaml
```

Apply (first pass — IRSA only; CloudFront comes after the LB exists):

```bash
terraform init
terraform apply
terraform output -raw triage_bedrock_role_arn      # → into the SA annotation (step 3)
```

> Using your **own** domain + ALB + TLS instead of CloudFront? Skip
> `listener_lb_dns` entirely and point Jira at your ALB URL. The rest is identical.

## Step 2 — Build and push the image

The image is `linux/amd64` (match it to your node arch). Build context is
`agent/`. It's built as **three layers, agent-blank until the last** — base
(engine) → `<harness>` (engine + CLI) → `<agent>` (the one agent). Each agent
owns its `Dockerfile` under `agent/agents/<name>/`. One agent per image, deployed
in isolation. Pick the harness — see [Choose your harness](03b-choose-harness.md).

`REPO` is your full registry + repo path — **any registry** (ECR, Nexus, Harbor,
GHCR, …). `docker login` to it first (for ECR: `aws ecr get-login-password
--region <region> | docker login --username AWS --password-stdin <acct>.dkr.ecr.<region>.amazonaws.com`).

```bash
REPO=<your-registry>/triage-agent      # e.g. nexus.corp:8891/triage-agent  or  <acct>.dkr.ecr.<region>.amazonaws.com/triage-agent

# base (engine) → pi (engine + CLI) → jira-triage (one agent).
docker build -f agent/deploy/docker/base.Dockerfile   -t agent-base:local       agent
docker build -f agent/deploy/docker/pi.Dockerfile     --build-arg BASE=agent-base:local -t agent-pi:local agent
docker build -f agent/agents/jira-triage/Dockerfile   --build-arg BASE=agent-pi:local   -t "$REPO:latest"  agent
docker push "$REPO:latest"
# (swap pi.Dockerfile → kiro/opencode; swap the agent Dockerfile for another agent)
```

(The one-liner is `make agent-image AGENT=jira-triage HARNESS=pi REGISTRY=$REPO`.)

> **Private registry (Nexus/Harbor/…)?** The cluster also needs to pull it: create
> a `docker-registry` pull secret in the `agents` namespace and set
> `imagePullSecrets` + `IMAGE_PULL_SECRET` in `receiver.yaml` (both are commented
> placeholders there). ECR via the node role needs neither.

## Step 3 — Fill in the manifests

Copy the templated config/secret and set the placeholders.

```bash
cp agent/deploy/k8s/config.example.yaml  agent/deploy/k8s/config.yaml    # fill (see Configure Jira §3)
cp agent/deploy/k8s/secrets.example.yaml agent/deploy/k8s/secrets.yaml   # fill secrets
```

`agent/deploy/k8s/secrets.yaml` — set the credentials. You need the auth secret
for **your** trigger path (and may leave the other as a placeholder):

Keys are **UPPER_SNAKE_CASE** — the run Job loads the secret via `envFrom`, which
maps each key verbatim to an env var, and the scripts/harnesses read standard env
names. Dash-cased keys are silently dropped by the shell (the run would fail
`JIRA_* is required`).

| Key | Value |
|---|---|
| `JIRA_EMAIL` / `JIRA_API_TOKEN` | the bot account from [Configure Jira](03-configure-jira.md) |
| `GITLAB_READ_TOKEN` | the read-only token from [Configure GitLab](02-configure-gitlab.md) |
| `WEBHOOK_HMAC_SECRET` | `openssl rand -hex 32` — **DC/Server** (system webhook) path |
| `AUTOMATION_SHARED_SECRET` | `openssl rand -hex 32` — **Cloud** (Automation rule) path |
| `KIRO_API_KEY` *(kiro-cli only)* | from the Kiro portal — pi/opencode ignore it |
| `ANTHROPIC_API_KEY` *(opencode only)* | your provider key — pi/kiro ignore it |

`agent/deploy/k8s/namespace.yaml` — set the **agent-runner** ServiceAccount
annotation to the `triage_bedrock_role_arn` output from step 1 (the run Jobs use
it for Bedrock; the receiver needs no cloud creds).

`agent/deploy/k8s/receiver.yaml` — set:

- `image:` and the `AGENT_IMAGE` env → your `$REPO:latest` (the receiver stamps
  this into the Jobs it creates — normally its own image).
- `AUTHORIZED_ACTORS` → comma-separated accountIds allowed to trigger (R6b).
- `RUN_ENV` → non-secret env for each run Job: `HARNESS=<adapter>`, `MODEL`/
  `OPENCODE_MODEL`, `GITLAB_BASE_URL`, etc. The exact `RUN_ENV` differs per
  harness — copy the row for yours from
  [Choose your harness → Receiver `RUN_ENV` per harness](03b-choose-harness.md#receiver-run_env-per-harness-the-one-thing-you-set).
  It must match the harness baked into the image.
- `RUN_SECRET` / `RUN_CONFIGMAP` already point at `agent-secrets` / `agent-config`
  — the run Job loads creds itself via `envFrom`, so the receiver never sees them.

`count/pods` in `resourcequota.yaml` caps concurrent runs — tune to taste.

## Step 4 — Apply

```bash
kubectl apply -f agent/deploy/k8s/namespace.yaml      # ns + 2 ServiceAccounts
kubectl apply -f agent/deploy/k8s/rbac.yaml           # receiver → create Jobs
kubectl apply -f agent/deploy/k8s/resourcequota.yaml  # concurrency cap
kubectl apply -f agent/deploy/k8s/netpol.yaml         # run-pod egress fence
kubectl apply -f agent/deploy/k8s/config.yaml
kubectl apply -f agent/deploy/k8s/secrets.yaml
kubectl apply -f agent/deploy/k8s/receiver.yaml

kubectl -n agents rollout status deploy/agent-receiver
```

The receiver is **stateless** — it's Ready as soon as it's up (no `/myself`, no
warm-up). `make agent-deploy` runs this whole sequence.

## Step 5 — Expose the receiver (CloudFront or your own ALB)

`receiver.yaml` creates the `agent-receiver` Service as an **NLB managed by the
AWS Load Balancer Controller, locked to CloudFront's origin via a managed prefix
list** (R10b) — reachable only through CloudFront, which `agent/deploy/terraform`
provisions as its origin.

> **Why an NLB + prefix list, not a classic ELB + CIDR ranges?** CloudFront's
> origin range is ~45 CIDRs. The in-tree classic-ELB provider turns
> `loadBalancerSourceRanges` into **one security-group rule per CIDR** — ~45
> rules, which overflows the **60-rules-per-SG limit**, so the LB silently never
> provisions (`RulesPerSecurityGroupLimitExceeded`). The LBC can instead
> reference the whole CloudFront prefix list as a **single** SG rule. That's why
> the Service uses `loadBalancerClass: service.k8s.aws/nlb` and the
> `aws-load-balancer-security-group-prefix-lists` annotation.

**Prerequisite — the AWS Load Balancer Controller** must be installed in the
cluster (it owns the `service.k8s.aws/nlb` class). Most production EKS clusters
already run it: `kubectl -n kube-system get deploy aws-load-balancer-controller`.
If absent, install it (Helm chart `eks-charts/aws-load-balancer-controller` with
an IRSA role carrying the LBC policy) before applying `receiver.yaml`.

Set the prefix-list id for **your** region in the Service annotation
(`receiver.yaml`) — it defaults to the `us-west-2` id:

```bash
cd agent/deploy/terraform
terraform output -raw cloudfront_origin_prefix_list_id   # → pl-xxxxxxxx for your region
# put it in receiver.yaml:
#   service.beta.kubernetes.io/aws-load-balancer-security-group-prefix-lists: "pl-xxxxxxxx"
```

Then wire CloudFront to the NLB hostname:

```bash
LB=$(kubectl -n agents get svc agent-receiver \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
cd agent/deploy/terraform
terraform apply -var "listener_lb_dns=$LB"
terraform output -raw triage_webhook_url          # → the /jira-webhook URL for Jira
```

Prefer your **own ALB + domain + TLS**? Change the Service to `ClusterIP`, drop
the NLB annotations, point the ALB at it, and lock the origin with the ALB
security group / WAF instead. The webhook URL you register in Jira is then
`https://<your-domain>/webhook`.

> **Verify the lock:** a direct request to the LB hostname (bypassing CloudFront)
> must be refused (it will hang/time out — only the CloudFront prefix list is
> allowed inbound).

## Step 6 — Register the trigger in Jira

Go back to [Configure Jira](03-configure-jira.md) and create the **Automation
rule** (Cloud) or **system webhook** (DC/Server) pointing at your `/webhook` URL.

## Pre-launch verification (blocking)

These can't be checked from code alone — they need the live cluster/Jira. Do all
of them **before** pointing the trigger at a real project:

- [ ] **Receiver can create Jobs.** Send one signed test event and confirm a Job
      appears: `kubectl -n agents get jobs`. If creation is forbidden, check
      `rbac.yaml` is applied and the receiver uses the `agent-receiver` SA.
- [ ] **Dedupe works.** Re-send the same delivery id — the second create returns
      409 and is logged `duplicate`, no second Job.
- [ ] **Real Jira API shapes.** With the bot token against a throwaway test
      issue, confirm the v3 request shapes the skill assumes. Fix
      `agent/agents/jira-triage/scripts/jira.sh` if your instance differs.
- [ ] **(DC/Server) Captured HMAC signature.** Confirm the actual
      `X-Hub-Signature` algorithm/prefix matches `runtime/lib/auth.js` (`sha256=`).
- [ ] **NetworkPolicy enforcement.** `netpol.yaml` is inert unless the VPC CNI
      network-policy controller is enabled (`ENABLE_NETWORK_POLICY=true` on the
      `aws-node` add-on). Confirm it's on, or the egress exfil boundary doesn't
      exist — see [Security](06-security.md).
- [ ] **Concurrency + spend.** Set `count/pods` in `resourcequota.yaml` to your
      tolerance, and set an **AWS Budget / Bedrock quota** as the cumulative
      dollar backstop (there is no in-app daily counter — see [Security](06-security.md)).

Next → [Operations](05-operations.md)
