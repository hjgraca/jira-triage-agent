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
`agent/`. Each harness has its own Dockerfile under `agent/deploy/docker/`, all
built FROM a shared `base.Dockerfile` (the runtime + agents). Pick the harness —
see [Choose your harness](03b-choose-harness.md).

```bash
REPO=<acct>.dkr.ecr.<region>.amazonaws.com/triage-agent
aws ecr get-login-password --region <region> | docker login --username AWS --password-stdin "${REPO%/*}"

# Build the shared base once, then the selected harness FROM it (default: pi).
docker buildx build --platform linux/amd64 \
  -f agent/deploy/docker/base.Dockerfile -t triage-base:local --load agent
docker buildx build --platform linux/amd64 \
  -f agent/deploy/docker/pi.Dockerfile --build-arg BASE=triage-base:local \
  -t "$REPO:latest" --push agent
# (swap pi.Dockerfile → kiro.Dockerfile / opencode.Dockerfile for another harness)
```

(The workshop equivalent is `make triage-image HARNESS=pi`.)

## Step 3 — Fill in the manifests

Copy the templated config/secret and set the placeholders.

```bash
cp agent/deploy/k8s/triage-config.example.yaml  agent/deploy/k8s/triage-config.yaml    # fill (see Configure Jira §3)
cp agent/deploy/k8s/triage-secrets.example.yaml agent/deploy/k8s/triage-secrets.yaml   # fill secrets
```

`agent/deploy/k8s/triage-secrets.yaml` — set the credentials. You need the auth secret
for **your** trigger path (and may leave the other as a placeholder):

| Key | Value |
|---|---|
| `jira-email` / `jira-api-token` | the bot account from [Configure Jira](03-configure-jira.md) |
| `gitlab-read-token` | the read-only token from [Configure GitLab](02-configure-gitlab.md) |
| `webhook-hmac-secret` | `openssl rand -hex 32` — **DC/Server** (system webhook) path |
| `automation-shared-secret` | `openssl rand -hex 32` — **Cloud** (Automation rule) path |

`agent/deploy/k8s/triage-namespace.yaml` — set the ServiceAccount annotation to the
`triage_bedrock_role_arn` output from step 1.

`agent/deploy/k8s/triage-listener.yaml` — set:

- `image:` → your `$REPO:latest`
- `JIRA_BASE_URL` → your Jira base URL
- `GITLAB_BASE_URL` → reachable GitLab URL (see [Configure GitLab](02-configure-gitlab.md#2-make-gitlab-reachable-from-the-cluster))
- `AUTHORIZED_ACTORS` → comma-separated accountIds allowed to trigger (R6b)
- `HARNESS` → `pi` (default) or `kiro-cli` — must match what you baked into the
  image (step 2) and the credential you set (step 3). See
  [Choose your harness](03b-choose-harness.md).
- (optional) `TRIAGE_MODEL`, `MAX_CONCURRENT`, `SPAWN_CEILING`, `DAILY_BUDGET`

## Step 4 — Apply

```bash
kubectl apply -f agent/deploy/k8s/triage-namespace.yaml
kubectl apply -f agent/deploy/k8s/triage-config.yaml
kubectl apply -f agent/deploy/k8s/triage-secrets.yaml
kubectl apply -f agent/deploy/k8s/triage-netpol.yaml
kubectl apply -f agent/deploy/k8s/triage-listener.yaml

kubectl -n triage rollout status deploy/triage-listener
```

The pod becomes **Ready** only once it resolves the bot accountId via `/myself`
(fail-closed readiness — without it the loop guard is blind). If it stays
not-ready, check `JIRA_*` secret values and egress to Jira.

## Step 5 — Wire CloudFront and lock the origin (R10b)

Get the listener's LoadBalancer hostname, then run the **second** terraform apply
to create CloudFront in front of it:

```bash
LB=$(kubectl get svc -n triage triage-listener \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')

cd agent/deploy/terraform
terraform apply -var "listener_lb_dns=$LB"
terraform output -raw triage_webhook_url          # → register in Jira (step 03)
terraform output -json cloudfront_origin_cidrs    # → loadBalancerSourceRanges
```

Paste the `cloudfront_origin_cidrs` into
`agent/deploy/k8s/triage-listener.yaml`'s `loadBalancerSourceRanges`, then re-apply the
listener:

```bash
kubectl apply -f agent/deploy/k8s/triage-listener.yaml
```

Now only CloudFront can reach the public LB. Verify a **direct** POST to the LB
hostname (bypassing CloudFront) is refused.

## Step 6 — Register the trigger in Jira

Go back to [Configure Jira](03-configure-jira.md) and create the **Automation
rule** (Cloud) or **system webhook** (DC/Server) pointing at the
`triage_webhook_url`.

## Pre-launch verification (blocking)

These can't be checked from code alone — they need the live cluster/Jira. Do all
of them **before** pointing the trigger at a real project, because the agent
writes to real tickets:

- [ ] **Real Jira API shapes.** With the bot token against a throwaway test
      issue, confirm the v3 request shapes the skill assumes (comment ADF body,
      `set-fields`, and whether issue-type is a field edit or a
      transition-with-screen in your workflow). Fix `agent/agents/jira-triage/scripts/jira.sh`
      if your instance differs.
- [ ] **(DC/Server) Captured HMAC signature.** Trigger one real webhook to a
      logging endpoint, capture the actual `X-Hub-Signature`, and confirm the
      algorithm/prefix matches `gate.js` (assumed `sha256=`).
- [ ] **LB origin lock (R10b).** `loadBalancerSourceRanges` is populated with
      `cloudfront_origin_cidrs` and re-applied. A direct POST to the LB is refused.
- [ ] **NetworkPolicy enforcement.** `agent/deploy/k8s/triage-netpol.yaml` is inert
      unless the VPC CNI network-policy controller is enabled
      (`ENABLE_NETWORK_POLICY=true` on the `aws-node` add-on). Confirm it's on, or
      the egress exfil boundary doesn't exist — see [Security](06-security.md).
- [ ] **Daily spend budget.** `DAILY_BUDGET` (default 500 runs/24h) caps Bedrock
      cost. `issue_created` has no per-actor authz, so this is the backstop if
      issue creation is open to untrusted reporters. Set it to your tolerance.

Next → [Operations](05-operations.md)
