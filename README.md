# Agentic-Dev Workshop Platform

Infrastructure for a customer-workshop environment: an Amazon EKS cluster
hosting self-managed **GitLab**, used to test agentic development in an
environment similar to a customer's. Issue tracking uses **Jira Cloud**
(`*.atlassian.net`) — it is not deployed here.

Everything runs on EKS. This is a **starting point** — see [Caveats](#caveats).

## Layout

```
terraform/      VPC + EKS cluster (terraform-aws-modules)
helm/           Helm values for GitLab
k8s/            Raw manifests applied after Helm (e.g. the SSH LoadBalancer)
Makefile        Orchestration: cluster -> kubeconfig -> apps
docs/           Ideation notes
```

## Prerequisites

- AWS account + credentials configured (`aws sts get-caller-identity` works)
- Terraform >= 1.5.7
- `kubectl`, `helm`, and the `aws` CLI on PATH

## Bring it up

```bash
make up
```

That runs, in order:

1. `make cluster` — `terraform apply` for the VPC + EKS cluster (~15 min)
2. `make kubeconfig` — points `kubectl` at the new cluster
3. `make apps` — installs GitLab

Override defaults inline, e.g. `make up REGION=eu-west-1 CLUSTER=brisa DOMAIN=workshop.brisa.dev`.

### Accessing GitLab

GitLab is exposed via its bundled nginx ingress (an AWS LoadBalancer).
Get the LoadBalancer hostname:

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

### Git over SSH

Web (80/443) is public on the nginx LoadBalancer, but **git-over-SSH (port 22)
runs on its own LoadBalancer locked to a single source IP** — see
[Security](#security). To clone/push over SSH:

1. Get the SSH LoadBalancer hostname:

   ```bash
   kubectl get svc -n gitlab gitlab-shell-ssh \
     -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
   ```

2. Point `~/.ssh/config` at it (a `workshop-gitlab` host alias is set up locally;
   update its `HostName` when the cluster is recreated):

   ```
   Host workshop-gitlab
       HostName <ssh-lb-hostname>
       User git
       IdentityFile ~/.ssh/id_ecdsa
       IdentitiesOnly yes
   ```

3. Upload your public key to **GitLab > Preferences > SSH Keys**, then clone
   with `git clone git@workshop-gitlab:<group>/<project>.git`.

## Jira Cloud integration

Issue tracking is **Jira Cloud** (`*.atlassian.net`), wired to GitLab via the
built-in Jira integration. It is **one-way**: GitLab pushes to Jira; Jira does
not call back into GitLab.

- GitLab's EKS nodes have outbound internet (NAT), so GitLab reaches Jira Cloud.
- The reverse (Jira's *Development* panel showing branches/commits/MRs) is **not**
  set up — it needs GitLab on a public DNS name with HTTPS, which this workshop
  cluster doesn't have.

**Setup** (GitLab project/group → Settings → Integrations → Jira):

- **Web URL**: `https://<your-site>.atlassian.net`
- **Auth**: Atlassian account email + an API token from
  <https://id.atlassian.com/manage-profile/security/api-tokens>
- Enable comments / transitions as desired, then **Test settings** (expect green).

**Usage** — reference the issue key in a commit message, branch name, or MR
title/description:

```
git commit -m "Fix login KAN-1"
```

GitLab renders `KAN-1` as a link and posts a comment back on the Jira issue.

> **Issue keys are case-sensitive — uppercase only.** `KAN-1` works; `kan-1`
> is ignored and won't link.

## Security

The shared nginx LoadBalancer fronting GitLab exposes web ports to
`0.0.0.0/0`, which is expected for a workshop. Git-over-SSH is treated
differently: an open port 22 from arbitrary IPs trips AWS network scanners
(Palisade Riddler), which auto-delete the listener.

To avoid that, SSH is **not** on the shared LB
(`nginx-ingress.controller.service.enableShell: false` in
`helm/gitlab-values.yaml`). Instead `k8s/gitlab-shell-ssh-lb.yaml` provisions a
dedicated LoadBalancer for the gitlab-shell pods, restricted to a single IP via
`loadBalancerSourceRanges`. `make gitlab` applies it automatically.

**When your public IP changes**, update the CIDR in
`k8s/gitlab-shell-ssh-lb.yaml` and re-run `make gitlab` (or `kubectl apply -f`
the manifest). Find your current IP with `curl https://checkip.amazonaws.com`.

## Tear it down

```bash
make destroy
```

This deletes Kubernetes LoadBalancer services and ingresses **first** (waiting
for AWS to release the ELBs/ENIs), then runs `terraform destroy`. Skipping that
order leaves orphaned ENIs that block VPC deletion.

## Caveats

This is a workshop starting point, not a production deployment:

- **In-cluster state.** GitLab's Postgres/Redis/MinIO run inside the cluster on
  EBS volumes. GitLab marks its bundled stateful services "evaluation only"
  (removed entirely in chart 10.x / GitLab 19.0), which is why the chart is
  pinned to 8.x here. For anything durable, move Postgres to RDS, Redis to
  ElastiCache, and object storage to S3.
- **No TLS.** HTTPS is disabled for simplicity. Add cert-manager + ACM or
  Let's Encrypt before exposing this beyond a workshop.
- **Cost.** The EKS control plane bills ~$0.10/hr and the node group runs
  continuously while up. Run `make destroy` when the platform is idle.
