# Workshop Lab

The full self-contained environment used to **develop and demo** the triage
agent: an Amazon EKS cluster hosting self-managed **GitLab**, with the agent
deployed on top. Issue tracking is **Jira Cloud** (`*.atlassian.net`) — not
deployed here, wired in via integration.

This is a **starting point**, not a production deployment — see [Caveats](#caveats).

> Installing the agent into a real cluster instead? You don't want this lab —
> go to [docs/customer-install/](../customer-install/).

## What `make` builds

```
make cluster   →  workshop/terraform apply: VPC + EKS + Bedrock IRSA + CloudFront (~15 min)
make kubeconfig →  point kubectl at the new cluster
make apps      →  GitLab (Helm) + the triage agent
make up        →  all of the above, in order
make destroy   →  delete k8s LoadBalancers first, then terraform destroy
```

## Prerequisites

- AWS account + credentials configured (`aws sts get-caller-identity` works)
- Terraform >= 1.5.7
- `kubectl`, `helm`, `docker` (with buildx), and the `aws` CLI on PATH

## Bring it up

```bash
make up
```

Override defaults inline:

```bash
make up REGION=eu-west-1 CLUSTER=brisa DOMAIN=workshop.brisa.dev
```

`make up` runs `make cluster` → `make kubeconfig` → `make apps`. The agent is
part of `make apps`, but it needs its secrets/config in place first — see
[Deploying the agent in the lab](#deploying-the-agent-in-the-lab).

## Accessing GitLab

GitLab is exposed via its bundled nginx ingress (an AWS LoadBalancer):

```bash
kubectl get svc -n gitlab gitlab-nginx-ingress-controller \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
```

These hostnames aren't in public DNS, so map `gitlab.<domain>` to the
LoadBalancer locally. `/etc/hosts` needs an **IP**, so resolve the LB first:

```bash
dig +short <lb-hostname>          # pick any returned IP (they can rotate)
sudo sh -c 'printf "\n%s  gitlab.workshop.example.com\n" <ip> >> /etc/hosts'
```

Then browse to **http://gitlab.workshop.example.com** (use `http://` — TLS is
off). Initial root password:

```bash
kubectl get secret -n gitlab gitlab-gitlab-initial-root-password \
  -o jsonpath='{.data.password}' | base64 -d
```

## Git over SSH

Web (80/443) is public on the nginx LoadBalancer, but **git-over-SSH (port 22)
runs on its own LoadBalancer locked to a single source IP** (see
[Security](#security)). To clone/push over SSH:

1. Get the SSH LoadBalancer hostname:

   ```bash
   kubectl get svc -n gitlab gitlab-shell-ssh \
     -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
   ```

2. Point `~/.ssh/config` at it (update `HostName` when the cluster is recreated):

   ```
   Host workshop-gitlab
       HostName <ssh-lb-hostname>
       User git
       IdentityFile ~/.ssh/id_ecdsa
       IdentitiesOnly yes
   ```

3. Upload your public key to **GitLab → Preferences → SSH Keys**, then
   `git clone git@workshop-gitlab:<group>/<project>.git`.

## Jira Cloud integration (GitLab → Jira)

This wires GitLab's built-in Jira integration so commits/branches/MRs link to
Jira issues. It is **one-way**: GitLab pushes to Jira; Jira does not call back
into GitLab. (The triage agent is the separate, Jira→agent direction —
[Configure Jira](../customer-install/03-configure-jira.md).)

- GitLab's EKS nodes have outbound internet (NAT), so GitLab reaches Jira Cloud.
- The reverse (Jira's *Development* panel showing branches/commits/MRs) is **not**
  set up — it needs GitLab on a public DNS name with HTTPS, which this lab lacks.

**Setup** (GitLab project/group → Settings → Integrations → Jira):

- **Web URL**: `https://<your-site>.atlassian.net`
- **Auth**: Atlassian account email + an API token from
  <https://id.atlassian.com/manage-profile/security/api-tokens>
- Enable comments / transitions as desired, then **Test settings** (expect green).

**Usage** — reference the issue key in a commit message, branch, or MR title:

```
git commit -m "Fix login KAN-1"
```

> **Issue keys are case-sensitive — uppercase only.** `KAN-1` works; `kan-1` is
> ignored and won't link.

## Deploying the agent in the lab

The agent install steps are the same as a customer's — the only difference is
that the workshop's `Makefile` and `workshop/terraform` already provide the
cluster and the Bedrock role. Follow:

1. **[Configure Jira](../customer-install/03-configure-jira.md)** — bot account,
   token, and the trigger (Automation rule on Cloud).
2. **[Deploy the agent](../customer-install/04-deploy-agent.md)** — but use the
   workshop Makefile shortcuts:

   ```bash
   make agent-image            # build + push the image to ECR
   # set the IRSA ARN, secrets, config, AUTHORIZED_ACTORS, JIRA_BASE_URL (see deploy guide)
   make triage                  # apply agent/deploy/k8s manifests
   # then wire CloudFront:
   LB=$(kubectl get svc -n agents agent-receiver \
     -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
   terraform -chdir=workshop/terraform apply -var "triage_listener_lb_dns=$LB"
   terraform -chdir=workshop/terraform output -raw triage_webhook_url
   terraform -chdir=workshop/terraform output -json cloudfront_origin_cidrs
   ```

The Bedrock IRSA role and CloudFront here come from **`workshop/terraform`**
(not `agent/deploy/terraform`), because the lab manages cluster and cloud deps in one
state. Everything else (manifests, image, skill) is identical to the customer
path.

## Security

The shared nginx LoadBalancer fronting GitLab exposes web ports to `0.0.0.0/0`,
expected for a workshop. Git-over-SSH is treated differently: an open port 22
from arbitrary IPs trips AWS network scanners (Palisade Riddler), which
auto-delete the listener.

So SSH is **not** on the shared LB
(`nginx-ingress.controller.service.enableShell: false` in
`workshop/helm/gitlab-values.yaml`). Instead
`workshop/k8s/gitlab-shell-ssh-lb.yaml` provisions a dedicated LoadBalancer for
the gitlab-shell pods, restricted to a single IP via `loadBalancerSourceRanges`.
`make gitlab` applies it automatically.

**When your public IP changes**, update the CIDR in
`workshop/k8s/gitlab-shell-ssh-lb.yaml` and re-run `make gitlab`. Find your
current IP with `curl https://checkip.amazonaws.com`.

For the agent's own security model, see
[Security](../customer-install/06-security.md) and
[Architecture → Trust model](../architecture/README.md#trust-model).

## Tear it down

```bash
make destroy
```

This deletes Kubernetes LoadBalancer services and ingresses **first** (waiting
for AWS to release the ELBs/ENIs), then runs `terraform destroy`. Skipping that
order leaves orphaned ENIs that block VPC deletion.

## Caveats

A workshop starting point, not a production deployment:

- **In-cluster state.** GitLab's Postgres/Redis/MinIO run inside the cluster on
  EBS. GitLab marks its bundled stateful services "evaluation only" (removed in
  chart 10.x / GitLab 19.0), which is why the chart is pinned to 8.x here. For
  anything durable, move Postgres to RDS, Redis to ElastiCache, storage to S3.
- **No TLS** inside the cluster. HTTPS is disabled for simplicity; CloudFront
  terminates TLS for the webhook. Add cert-manager + ACM before exposing GitLab
  beyond a workshop.
- **Cost.** The EKS control plane bills ~$0.10/hr and the node group runs
  continuously while up. Run `make destroy` when idle.
