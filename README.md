# Agentic-Dev Workshop Platform

Infrastructure for a customer-workshop environment: an Amazon EKS cluster
hosting self-managed **GitLab** and **Jira Data Center 10.3.18**, used to test
agentic development in an environment similar to a customer's.

Everything runs on EKS. This is a **starting point** — see [Caveats](#caveats).

## Layout

```
terraform/      VPC + EKS cluster (terraform-aws-modules)
helm/           Helm values for GitLab, Jira, and Jira's Postgres
k8s/            Raw manifests applied after Helm (e.g. the SSH LoadBalancer)
Makefile        Orchestration: cluster -> kubeconfig -> apps
docs/           Ideation notes
```

## Prerequisites

- AWS account + credentials configured (`aws sts get-caller-identity` works)
- Terraform >= 1.5.7
- `kubectl`, `helm`, and the `aws` CLI on PATH
- A Jira DC license — generate a free 30-day evaluation at
  <https://my.atlassian.com> (entered in the Jira setup wizard on first boot)

## Bring it up

```bash
make up
```

That runs, in order:

1. `make cluster` — `terraform apply` for the VPC + EKS cluster (~15 min)
2. `make kubeconfig` — points `kubectl` at the new cluster
3. `make apps` — installs GitLab, then Jira + its Postgres

Override defaults inline, e.g. `make up REGION=eu-west-1 CLUSTER=brisa DOMAIN=workshop.brisa.dev`.

### Accessing the apps

Both apps are exposed via the GitLab-bundled nginx ingress (an AWS LoadBalancer).
Get its hostname:

```bash
kubectl get svc -n gitlab gitlab-nginx-ingress-controller \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
```

Point DNS (or `/etc/hosts`) for `gitlab.<domain>` and `jira.<domain>` at it.

- **GitLab** initial root password:
  `kubectl get secret -n gitlab gitlab-gitlab-initial-root-password -o jsonpath='{.data.password}' | base64 -d`
- **Jira** finishes setup through its web wizard (enter the eval license + create the admin).

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

## Security

The shared nginx LoadBalancer fronting GitLab/Jira exposes web ports to
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

- **In-cluster state.** GitLab's Postgres/Redis/MinIO and Jira's Postgres run
  inside the cluster on EBS volumes. GitLab marks its bundled stateful services
  "evaluation only" (removed entirely in chart 10.x / GitLab 19.0), which is why
  the chart is pinned to 8.x here. For anything durable, move Postgres to RDS,
  Redis to ElastiCache, and object storage to S3.
- **No TLS.** HTTPS is disabled for simplicity. Add cert-manager + ACM or
  Let's Encrypt before exposing this beyond a workshop.
- **Single-replica Jira.** One node, RWO EBS shared-home. Multi-node Jira DC
  would need EFS (RWX) shared storage.
- **Eval license clock.** The Jira DC evaluation license expires after 30 days.
- **Cost.** The EKS control plane bills ~$0.10/hr and the node group runs
  continuously while up. Run `make destroy` when the platform is idle.
