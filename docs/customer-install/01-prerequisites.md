# 01 — Prerequisites

What must exist before you install the agent, and how to gather the values the
later steps ask for.

← [Overview](README.md) · Next → [Configure GitLab](02-configure-gitlab.md)

---

## 1. An EKS cluster with an IAM OIDC provider

The agent authenticates to Bedrock via **IRSA**, which requires the cluster to
have an IAM OIDC identity provider. Most clusters created in the last few years
have one; confirm and capture its ARN.

```bash
CLUSTER=<your-cluster>
REGION=<your-region>

# The cluster's OIDC issuer URL:
aws eks describe-cluster --name "$CLUSTER" --region "$REGION" \
  --query 'cluster.identity.oidc.issuer' --output text
# → https://oidc.eks.<region>.amazonaws.com/id/EXAMPLED539D4633E53DE1B716D3041E

# The matching IAM OIDC provider ARN (compare the trailing id to the URL above):
aws iam list-open-id-connect-providers
```

If no provider is listed for that issuer, create one once:

```bash
eksctl utils associate-iam-oidc-provider --cluster "$CLUSTER" --region "$REGION" --approve
```

You'll pass the **provider ARN** into `agent/deploy/terraform` as `oidc_provider_arn`.

## 2. Amazon Bedrock model access

The agent calls one model (default `us.anthropic.claude-sonnet-4-6`). Confirm the
account/region has access to it (Bedrock console → Model access), or pick a model
you do have and set `bedrock_model_id` in terraform. The IAM policy is scoped to
exactly that model — do not widen it to `*`.

## 3. A container registry the cluster can pull from

ECR is assumed in examples, but any registry works. You need push access from
your build machine and pull access from the cluster's node role.

```bash
aws ecr create-repository --repository-name triage-agent --region "$REGION"   # if needed
```

## 4. Network reachability

The pod must reach, on egress:

- **Amazon Bedrock** (HTTPS) — in-region.
- **Your Jira** (HTTPS) — Cloud (`*.atlassian.net`) or your Data Center host.
- **Your GitLab** — in-cluster Service DNS, or a reachable URL.

And Jira must reach the **receiver's webhook endpoint** on ingress. Front the
`agent-receiver` Service with CloudFront (default in [Deploy](04-deploy-agent.md))
or your own ALB, and lock the origin so only that front door can reach the
Service.

> The default CloudFront path provisions the receiver as an **NLB managed by the
> AWS Load Balancer Controller**, so it can lock the origin to CloudFront's
> managed prefix list with a single SG rule (a classic ELB + ~45 CIDR ranges
> overflows the 60-rules-per-SG limit and won't provision). The LBC must be
> installed in the cluster — `kubectl -n kube-system get deploy
> aws-load-balancer-controller`. See [Deploy → Step 5](04-deploy-agent.md).

> If the cluster enforces NetworkPolicy (AWS VPC CNI with the network-policy
> controller enabled), the bundled `agent/deploy/k8s/netpol.yaml` egress
> allowlist applies. If it does **not** enforce policy, that file is inert — see
> [Security](06-security.md).

## 5. Tooling

| Tool | Version | Used for |
|---|---|---|
| `kubectl` | matching your cluster | applying `agent/deploy/k8s` |
| `terraform` | >= 1.5 | `agent/deploy/terraform` (IRSA + CloudFront) |
| `docker` (with `buildx`) | recent | building the `linux/amd64` image |
| `aws` CLI | v2 | ECR login, EKS describe, terraform auth |
| `jq`, `curl`, `openssl` | any | secrets, probes, verification |

## Values to collect now

Have these ready for the later steps:

- [ ] Cluster **OIDC provider ARN** (step 1)
- [ ] **Region** and a unique **name prefix** for IAM resources (e.g. `acme-prod`)
- [ ] **Bedrock model id** you have access to
- [ ] **Registry** repo URI (e.g. `<acct>.dkr.ecr.<region>.amazonaws.com/triage-agent`)
- [ ] Your Jira **base URL** and whether it's **Cloud** or **Data Center**
- [ ] Your GitLab **base URL** (in-cluster Service DNS preferred)

Next → [Configure GitLab](02-configure-gitlab.md)
