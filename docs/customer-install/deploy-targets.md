# Deploy targets — run on any Kubernetes

The agent runs on **any** Kubernetes cluster. The deploy layer is split so the
cluster-specific bits are isolated:

```
agent/deploy/k8s/
  base/        PORTABLE — works on every cluster (namespace, rbac, quota,
               netpol, ingress-netpol, receiver, config/secrets templates)
  overlays/
    eks-bedrock/     EKS: keyless Bedrock model auth (IRSA role + SA annotation)
    aws-cloudfront/  AWS: public webhook ingress (LoadBalancer + CloudFront)
    vanilla/         everything else: static model key, no cloud overlay
```

The runtime itself is cloud-agnostic — it talks to the cluster through the
in-cluster Kubernetes API with the pod's ServiceAccount token (standard
`batch/v1` Jobs). Nothing in the engine assumes EKS.

## Pick your target

| Cluster | Apply | Model auth |
|---|---|---|
| **EKS** (Bedrock, recommended) | `base/` + `overlays/eks-bedrock` | **Keyless** — IRSA role scoped to one model, no stored key. Run `overlays/eks-bedrock/irsa-bedrock.sh`. |
| **GKE / AKS / on-prem / kind / k3s / …** | `base/` + `overlays/vanilla` | **Static key** in `agent-secrets` (a provider key for opencode/kiro-cli). See `overlays/vanilla/README.md`. |
| **Any of the above, public ingress** | add `overlays/aws-cloudfront` (AWS) or your own Ingress/ALB | orthogonal — combine with either row above |

Two axes, independent:
- **Identity / model auth** — `eks-bedrock` (keyless) *or* a static key (`vanilla`).
- **Ingress** — in-cluster `ClusterIP` (the `base/` receiver, default) *or* public
  (`aws-cloudfront`, or your own).

## What "any Kubernetes" requires

The base assumes only standard Kubernetes:
- A **ServiceAccount token** mounted in the pod (every cluster does this) — the
  receiver uses it to create Jobs via the in-cluster API.
- **RBAC** (`base/rbac.yaml`) letting the receiver SA create Jobs.
- Optionally a **NetworkPolicy-enforcing CNI** for the egress/ingress fences
  (`base/netpol.yaml`, `base/ingress-netpol.yaml`). If your CNI doesn't enforce
  policy they're inert — auth still gates everything; see [Security](06-security.md).

No EKS add-ons, no `eksctl`, no Terraform are needed for the base or the vanilla
overlay. Terraform + the AWS Load Balancer Controller appear only on the
AWS-specific `aws-cloudfront` / Cloud path.

## Model auth off EKS

There's no IRSA outside EKS, so the model credential is a **static key in the
Secret** instead of a keyless role — pick a key-based harness:

- `opencode` + `ANTHROPIC_API_KEY` (or another provider's env var)
- `kiro-cli` + `KIRO_API_KEY`
- `opencode` → Bedrock with a static `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`

(`pi` is keyless-Bedrock-only — use it on EKS.) Details:
[03b — Choose your harness](03b-choose-harness.md) and
`agent/deploy/k8s/overlays/vanilla/README.md`.

## Apply, generically

```bash
# 1. base (every cluster)
kubectl apply -f agent/deploy/k8s/base/namespace.yaml
kubectl apply -f agent/deploy/k8s/base/rbac.yaml
kubectl apply -f agent/deploy/k8s/base/resourcequota.yaml
kubectl apply -f agent/deploy/k8s/base/netpol.yaml
kubectl apply -f agent/deploy/k8s/base/ingress-netpol.yaml   # in-cluster input only
kubectl apply -f agent/deploy/k8s/base/config.yaml           # your filled copy
kubectl apply -f agent/deploy/k8s/base/secrets.yaml          # your filled copy
kubectl apply -f agent/deploy/k8s/base/receiver.yaml

# 2. identity overlay (EKS only)
kubectl apply -f agent/deploy/k8s/overlays/eks-bedrock/sa-irsa-patch.yaml   # EKS keyless
#   (vanilla: nothing here — the static key in agent-secrets is the credential)

kubectl -n agents rollout status deploy/agent-receiver
```

Or, from `agent/`: `make agent-deploy` (base) / `make agent-deploy
OVERLAY=eks-bedrock` (base + EKS identity).

Each overlay folder has a README with its exact apply sequence:
`agent/deploy/k8s/overlays/{eks-bedrock,vanilla,aws-cloudfront}/README.md`.
