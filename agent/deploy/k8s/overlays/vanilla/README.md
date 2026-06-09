# Overlay: vanilla — any Kubernetes (GKE, AKS, on-prem, kind, …)

The default for **any cluster that isn't EKS**. `base/` already runs anywhere; this
overlay only documents the one thing base can't assume off-EKS: **how the model
credential reaches the run pod**.

There is **no IRSA** outside EKS, so the model credential is a **static key in the
Secret** instead of a keyless role. That's the only difference — pick a harness
that authenticates with a key:

| Harness | Key in `agent-secrets` | Model |
|---|---|---|
| `opencode` | `ANTHROPIC_API_KEY` (or your provider's env var) | any provider opencode supports |
| `kiro-cli` | `KIRO_API_KEY` | Kiro's backend |
| `opencode` → Bedrock with a static AWS key | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | Bedrock, no IRSA |

(`pi` is Bedrock-keyless-only — use it on the `eks-bedrock` overlay, not here.)

## Apply

```bash
# 1. base — works on any cluster
kubectl apply -f agent/deploy/k8s/base/namespace.yaml
kubectl apply -f agent/deploy/k8s/base/rbac.yaml
kubectl apply -f agent/deploy/k8s/base/resourcequota.yaml
kubectl apply -f agent/deploy/k8s/base/netpol.yaml
kubectl apply -f agent/deploy/k8s/base/ingress-netpol.yaml      # in-cluster input only
kubectl apply -f agent/deploy/k8s/base/config.yaml              # your filled copy
kubectl apply -f agent/deploy/k8s/base/secrets.yaml             # incl. the static model key
kubectl apply -f agent/deploy/k8s/base/receiver.yaml            # set RUN_ENV HARNESS=opencode|kiro-cli

# 2. NO identity overlay — the static key in agent-secrets is the model credential.
kubectl -n agents rollout status deploy/agent-receiver
```

In `base/receiver.yaml`, set `RUN_ENV` to a key-based harness, e.g.
`HARNESS=opencode,OPENCODE_MODEL=anthropic/claude-sonnet-4-6,GITLAB_BASE_URL=…`.

> **Egress fence note:** `base/netpol.yaml` allows HTTPS:443 out, so the harness
> can reach its provider API. If your cluster's CNI doesn't enforce NetworkPolicy,
> the fence is inert (same caveat as everywhere) — see
> [Security](../../../../../docs/customer-install/06-security.md).
