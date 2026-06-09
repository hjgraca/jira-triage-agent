# Overlay: aws-cloudfront — public webhook ingress (Jira Cloud / external trigger)

Use this **instead of** `base/receiver.yaml` when the input source is **outside**
the cluster (Jira Cloud, or any SaaS webhook) and must reach the receiver over the
public internet. It swaps the in-cluster `ClusterIP` receiver for a
**LoadBalancer** (NLB) fronted by **CloudFront**, with the origin locked to
CloudFront's prefix list.

This overlay is **AWS-specific** (CloudFront + the AWS Load Balancer Controller).
For a non-AWS public ingress, front `base/receiver.yaml` with your own
Ingress/ALB/Gateway and lock the origin yourself — the receiver itself is just
HTTP on :8080.

What this overlay changes vs `base/`:
- **`receiver.yaml`** — `Service` type `LoadBalancer` (LBC-managed NLB, prefix-list
  origin lock) instead of `ClusterIP`; `TRIGGER=jira` (Cloud) instead of `jira-dc`.
- Pairs with `agent/deploy/terraform` (the CloudFront distribution + IRSA), the
  Cloud deploy path. See [04 — Deploy the agent](../../../../../docs/customer-install/04-deploy-agent.md).

## Apply

```bash
# base (minus base/receiver.yaml — this overlay replaces it; skip base/ingress-netpol too)
kubectl apply -f agent/deploy/k8s/base/namespace.yaml
kubectl apply -f agent/deploy/k8s/base/rbac.yaml
kubectl apply -f agent/deploy/k8s/base/resourcequota.yaml
kubectl apply -f agent/deploy/k8s/base/netpol.yaml
kubectl apply -f agent/deploy/k8s/base/config.yaml
kubectl apply -f agent/deploy/k8s/base/secrets.yaml
# this overlay's receiver (LoadBalancer + CloudFront origin lock)
kubectl apply -f agent/deploy/k8s/overlays/aws-cloudfront/receiver.yaml
kubectl -n agents rollout status deploy/agent-receiver
```

Model auth is orthogonal: combine with `eks-bedrock` (keyless) or a static key
exactly as on the in-cluster path.
