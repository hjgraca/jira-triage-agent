# Overlay: eks-bedrock — keyless Bedrock on Amazon EKS (recommended on EKS)

Adds **keyless** model auth on EKS: the `agent-runner` ServiceAccount assumes a
scoped IAM role via IRSA, so **no model key is stored** anywhere. This is the
recommended path when you're on EKS and using Bedrock (the `pi` harness).

What this overlay adds over `base/`:
- **`irsa-bedrock.sh`** — creates the one IAM role (policy scoped to a single
  model, never `*`), associates the cluster OIDC provider, and binds the role to
  `agents:agent-runner`. Plain `aws` CLI — nothing else to install or manage.
- **`sa-irsa-patch.yaml`** — the `agent-runner` SA with the role-ARN annotation
  (the script also annotates the live SA, so this is mostly for record/re-apply).

## Apply

```bash
# 1. base
kubectl apply -f agent/deploy/k8s/base/namespace.yaml
kubectl apply -f agent/deploy/k8s/base/rbac.yaml
kubectl apply -f agent/deploy/k8s/base/resourcequota.yaml
kubectl apply -f agent/deploy/k8s/base/netpol.yaml
kubectl apply -f agent/deploy/k8s/base/ingress-netpol.yaml
kubectl apply -f agent/deploy/k8s/base/config.yaml
kubectl apply -f agent/deploy/k8s/base/secrets.yaml             # NO model key needed
kubectl apply -f agent/deploy/k8s/base/receiver.yaml            # RUN_ENV HARNESS=pi

# 2. eks-bedrock identity overlay
CLUSTER=<eks-cluster> REGION=<region> \
  agent/deploy/k8s/overlays/eks-bedrock/irsa-bedrock.sh         # creates + annotates
# (or paste the printed ARN into sa-irsa-patch.yaml and:
#  kubectl apply -f agent/deploy/k8s/overlays/eks-bedrock/sa-irsa-patch.yaml)

kubectl -n agents rollout status deploy/agent-receiver
```

In `base/receiver.yaml`, set `RUN_ENV` to the keyless Bedrock harness, e.g.
`HARNESS=pi,MODEL=eu.anthropic.claude-sonnet-4-6,AWS_REGION=eu-west-1,GITLAB_BASE_URL=…`.
The `MODEL`/`AWS_REGION` MUST match what `irsa-bedrock.sh` scoped the policy to.

> opencode can also use this overlay (keyless Bedrock) — set
> `OPENCODE_MODEL=amazon-bedrock/<model>` + `AWS_REGION`. See
> [03b — Choose your harness](../../../../../docs/customer-install/03b-choose-harness.md).
