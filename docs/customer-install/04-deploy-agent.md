# 04 — Deploy the Agent

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
region            = "us-west-2"
oidc_provider_arn = "arn:aws:iam::111122223333:oidc-provider/oidc.eks.us-west-2.amazonaws.com/id/EXAMPLE..."
# bedrock_model_id = "us.anthropic.claude-sonnet-4-6"
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

```bash
REPO=<acct>.dkr.ecr.<region>.amazonaws.com/triage-agent
aws ecr get-login-password --region <region> | docker login --username AWS --password-stdin "${REPO%/*}"

# base (engine) → pi (engine + CLI) → jira-triage (one agent).
docker build -f agent/deploy/docker/base.Dockerfile   -t agent-base:local       agent
docker build -f agent/deploy/docker/pi.Dockerfile     --build-arg BASE=agent-base:local -t agent-pi:local agent
docker build -f agent/agents/jira-triage/Dockerfile   --build-arg BASE=agent-pi:local   -t "$REPO:latest"  agent
docker push "$REPO:latest"
# (swap pi.Dockerfile → kiro/opencode; swap the agent Dockerfile for another agent)
```

(The one-liner is `make agent-image AGENT=jira-triage HARNESS=pi`.)

## Step 3 — Fill in the manifests

Copy the templated config/secret and set the placeholders.

```bash
cp agent/deploy/k8s/config.example.yaml  agent/deploy/k8s/config.yaml    # fill (see Configure Jira §3)
cp agent/deploy/k8s/secrets.example.yaml agent/deploy/k8s/secrets.yaml   # fill secrets
```

`agent/deploy/k8s/secrets.yaml` — set the credentials. You need the auth secret
for **your** trigger path (and may leave the other as a placeholder):

| Key | Value |
|---|---|
| `jira-email` / `jira-api-token` | the bot account from [Configure Jira](03-configure-jira.md) |
| `gitlab-read-token` | the read-only token from [Configure GitLab](02-configure-gitlab.md) |
| `webhook-hmac-secret` | `openssl rand -hex 32` — **DC/Server** (system webhook) path |
| `automation-shared-secret` | `openssl rand -hex 32` — **Cloud** (Automation rule) path |

`agent/deploy/k8s/namespace.yaml` — set the **agent-runner** ServiceAccount
annotation to the `triage_bedrock_role_arn` output from step 1 (the run Jobs use
it for Bedrock; the receiver needs no cloud creds).

`agent/deploy/k8s/receiver.yaml` — set:

- `image:` and the `AGENT_IMAGE` env → your `$REPO:latest` (the receiver stamps
  this into the Jobs it creates — normally its own image).
- `AUTHORIZED_ACTORS` → comma-separated accountIds allowed to trigger (R6b).
- `RUN_ENV` → non-secret env for each run Job, e.g. `HARNESS=pi` (and
  `GITLAB_BASE_URL=...`, `TRIAGE_MODEL=...`). Must match the harness baked into
  the image — see [Choose your harness](03b-choose-harness.md).
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

Jira needs a public HTTPS URL that reaches the `agent-receiver` Service. Either
front it with CloudFront (domain-free, from `agent/deploy/terraform`) or your own
ALB + domain + TLS. Lock the origin so only your front door can reach the
Service (CloudFront origin CIDRs / your ALB security group). The webhook URL you
register in Jira is `https://<front-door>/webhook`.

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
