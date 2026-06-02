# Agentic-Dev Workshop Platform

Infrastructure for a customer-workshop environment: an Amazon EKS cluster
hosting self-managed **GitLab**, used to test agentic development in an
environment similar to a customer's. Issue tracking uses **Jira Cloud**
(`*.atlassian.net`) — it is not deployed here.

Everything runs on EKS. This is a **starting point** — see [Caveats](#caveats).

## Layout

```
terraform/      VPC + EKS cluster, Bedrock IRSA, CloudFront webhook ingress
helm/           Helm values for GitLab
k8s/            Raw manifests (SSH LB, triage namespace/listener/config/secrets)
skills/         pi.dev skills (jira-triage: the triage agent's rubric + scripts)
listener/       Webhook listener app (Node, no deps) that spawns triage runs
docker/         Container image build (triage agent)
Makefile        Orchestration: cluster -> kubeconfig -> apps
docs/           Ideation notes, brainstorms, plans
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

## Triage agent

An autonomous agent (built on the [pi.dev](https://github.com/earendil-works/pi)
coding harness) that triages Jira Cloud tickets: it classifies category, state,
and severity, then — for low/medium tickets — sets priority/labels/assignee/issue
type and posts an audit comment. High-severity tickets get a `needs-human` label
and a recommendation only (it never auto-writes the riskiest tickets).

**How it triggers.** An outbound request fires when the `triage` label is added
(or, for system webhooks, on issue creation). It hits a CloudFront URL (valid
TLS, no domain needed) whose origin is a dedicated in-cluster LoadBalancer. A
listener authenticates it, drops its own writes (loop guard) and unauthorized
label-adds, then spawns a one-shot `pi` run. The agent removes the `triage`
label when done, so the label doubles as a work-queue flag.

There are two supported trigger sources, and the listener accepts **either**:

- **Jira Automation rule (recommended on Cloud).** A no-code rule sends a web
  request on the label-add. Jira Cloud's "Send web request" **cannot compute an
  HMAC** over the body, so the rule instead presents a fixed shared-secret bearer
  in the `X-Triage-Token` header (`AUTOMATION_SHARED_SECRET`). This is a weaker
  primitive than per-message HMAC (a static token is replayable if leaked), so it
  leans on the other layers: the CloudFront-origin IP lock (R10b) blocks direct
  POSTs to the LB, and the actor allowlist (R6b) + dedupe (R8) + daily budget
  (R10c) bound what a replay could do. In practice this is the only path that
  reliably delivers on Jira Cloud — see the caveat under "Register the trigger".
- **Jira system webhook (HMAC).** Signs each delivery with `X-Hub-Signature`;
  the listener validates it in constant time. Preferred wherever it actually
  delivers (some Jira Cloud sites silently drop system-webhook delivery to
  arbitrary external URLs; Data Center / Server deliver reliably).

> **The agent writes to real tickets.** Guards: HMAC-authenticated webhook,
> allowlisted trigger actors, allowed-value-only field writes, severity-gated
> autonomy, and verify-before-write. Treat the listener as security-sensitive.

### One-time setup

1. **Jira bot account.** Create a dedicated Atlassian user for the agent and an
   API token (<https://id.atlassian.com/manage-profile/security/api-tokens>).
   The agent comments and edits as this user; its `accountId` is what the loop
   guard keys on.

2. **GitLab read token.** A minimum-privilege **project deploy token**
   (`read_repository`; add `read_api` only if routing needs it) — not a personal
   access token.

3. **HMAC secret.** `openssl rand -hex 32` — use the same value in the Jira
   webhook config and the Kubernetes secret.

4. **Allowed values.** Confirm the project's real priority names, issue types,
   label set, and the on-call **assignee accountIds** against the live `KAN`
   project, e.g. `jira.sh get KAN-1 | jq '.fields.priority, .fields.issuetype'`.
   Copy `k8s/triage-config.example.yaml` → `k8s/triage-config.yaml` and fill in.
   The agent **fails closed** on any value not in this list.

5. **Authorized actors.** Decide which Jira accountIds may trigger a run by
   adding the `triage` label, and set `AUTHORIZED_ACTORS` (comma-separated) in
   `k8s/triage-listener.yaml`. This stops anyone-who-can-edit-labels from
   spending Bedrock tokens.

### Deploy

```bash
# 1. Build + push the image, then set <TRIAGE_IMAGE> in k8s/triage-listener.yaml
make triage-image

# 2. Provision the Bedrock IRSA role; copy its ARN into k8s/triage-namespace.yaml
terraform -chdir=terraform apply
terraform -chdir=terraform output -raw triage_bedrock_role_arn

# 3. Create the real secret + config from the templates
cp k8s/triage-secrets.example.yaml k8s/triage-secrets.yaml   # fill in, then:
cp k8s/triage-config.example.yaml  k8s/triage-config.yaml    # fill in

# 4. Set JIRA_BASE_URL + AUTHORIZED_ACTORS + <TRIAGE_IMAGE> in triage-listener.yaml, then:
make triage

# 5. Wire CloudFront to the listener's LoadBalancer
LB=$(kubectl get svc -n triage triage-listener \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
terraform -chdir=terraform apply -var "triage_listener_lb_dns=$LB"
terraform -chdir=terraform output -raw triage_webhook_url        # → register in Jira
terraform -chdir=terraform output -json cloudfront_origin_cidrs  # → loadBalancerSourceRanges

# 6. Lock the LB to CloudFront (R10b): paste those CIDRs into
#    k8s/triage-listener.yaml's loadBalancerSourceRanges, then: make triage
```

### Register the trigger

> **Jira Cloud caveat.** System webhooks (`/rest/webhooks/1.0/`) frequently do
> **not** deliver to arbitrary external URLs on Cloud, even with a valid HMAC and
> a matching JQL filter — Atlassian steers external integrations to Connect/Forge
> or Automation. If you're on Cloud, use the **Automation rule** below. The
> system-webhook recipe is for Data Center / Server (where it delivers reliably).

#### Option A — Jira Automation rule (recommended on Cloud)

No-code, and the only path proven to deliver on Cloud. Set
`AUTOMATION_SHARED_SECRET` in `k8s/triage-secrets.yaml` first (`openssl rand -hex
32`), `kubectl apply` the secret, and roll the deployment.

In **Project settings → Automation → Create rule** (or global Automation):

1. **Trigger:** *Field value changed* → field **Labels**. (Or *Issue created*
   for the create path.)
2. **Condition (recommended):** *Issue fields condition* → **Labels** *contains*
   `triage`. This keeps the rule from firing on unrelated label edits.
3. **Action:** *Send web request*.
   - **URL:** the `triage_webhook_url` output
     (`https://<dist>.cloudfront.net/jira-webhook`)
   - **HTTP method:** `POST`
   - **Headers:**
     - `Content-Type: application/json`
     - `X-Triage-Token: <AUTOMATION_SHARED_SECRET>`
     - `X-Triage-Delivery-Id: {{rule.id}}-{{issue.key}}-{{issue.fields.updated}}`
       (a stable id so a retried delivery is deduped, not double-triaged)
   - **Web request body:** *Custom data*:
     ```json
     {
       "webhookEvent": "automation:label-added",
       "user": { "accountId": "{{initiator.accountId}}" },
       "issue": { "key": "{{issue.key}}" }
     }
     ```
   - Leave "Wait for response" unchecked (the listener acks fast and works async).

The `webhookEvent: automation:label-added` value tells the listener this came
from a rule (eligible by construction — the rule's own label condition is the
gate), while `initiator.accountId` keeps the R6b actor allowlist in force.

#### Option B — Jira system webhook (HMAC; Data Center / Server)

Create a **system** webhook (not a dynamic/Connect webhook — only system
webhooks carry the `X-Hub-Signature` HMAC the listener validates) in Jira admin
(**System → WebHooks**) or via `POST /rest/webhooks/1.0/webhook`:

- **URL**: the `triage_webhook_url` output (`https://<dist>.cloudfront.net/jira-webhook`)
- **Secret**: the HMAC secret from setup step 3
- **Events**: `Issue: created`, `Issue: updated`
- **JQL filter** (recommended): scope to the project, e.g. `project = KAN`

### Pre-launch verification (blocking)

These cannot be verified from code alone — they need the live Jira/cluster.
**Do all of them before registering the webhook on a real project**, because
the agent writes to real tickets and an open or mis-shaped path is hard to
walk back:

- [ ] **Real Jira API shapes (Step 0.5 probe).** With the bot token against a
      throwaway `KAN` test issue, confirm the v3 request shapes the skill
      assumes (`set-fields`/comment ADF body, and whether issue-type is a field
      edit or a transition-with-screen). The scripts mark these `VERIFY`. Fix
      `jira.sh` if the live API differs before pointing it at real tickets.
- [ ] **Captured HMAC signature.** Trigger one real webhook to a logging
      endpoint and capture the actual `X-Hub-Signature` + body. Confirm the
      algorithm/prefix matches `gate.js` (assumed `sha256=`) so the 401 path is
      validated against Jira's real signature, not a self-generated one.
- [ ] **LB origin lock (R10b).** Confirm `loadBalancerSourceRanges` in
      `k8s/triage-listener.yaml` is populated with the `cloudfront_origin_cidrs`
      output and re-applied — until then the public LB accepts anyone, with HMAC
      as the only gate. Verify a direct POST to the LB hostname (bypassing
      CloudFront) is refused.
- [ ] **NetworkPolicy enforcement.** The ingress/egress policy
      (`k8s/triage-netpol.yaml`) is inert unless the VPC CNI network-policy
      controller is enabled (`ENABLE_NETWORK_POLICY=true` on the `aws-node`
      add-on). Confirm it's on, or the egress exfil boundary doesn't exist.
- [ ] **Daily spend budget.** `DAILY_BUDGET` (default 500 runs/24h) caps
      Bedrock cost — `issue_created` has no per-actor authz, so this is the
      backstop if issue creation is open to untrusted reporters. Set it to your
      tolerance, and confirm issue-creation permissions match your assumption.

### Operations

- **Verify**: create a low/medium ticket in `KAN` (or add the `triage` label).
  The agent should set fields + post a comment starting with
  `> *This was generated by AI during triage.*`, then remove the `triage` label.
  A high-severity ticket gets `needs-human` + a recommendation, no field writes.
- **Credential rotation**: rotate the Jira token, GitLab token, and HMAC secret
  periodically (≤90 days). Procedure: revoke the old credential, generate a new
  one, update `k8s/triage-secrets.yaml` (and the Jira webhook secret for the
  HMAC), `kubectl apply`, then `kubectl rollout restart deploy/triage-listener -n triage`.
  If a token ever appears in logs, treat it as compromised and rotate immediately.
- **Logs**: the listener logs structured events only (no ticket bodies/PII).
  Review before forwarding stdout to a shared log sink.
- **Cost**: each accepted webhook spawns a billable Bedrock run. The listener
  bounds this with a concurrency semaphore (`MAX_CONCURRENT`) and a global rate
  ceiling (`SPAWN_CEILING`).

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
