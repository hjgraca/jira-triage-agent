# 04b — Deploy: Jira Data Center, in-cluster (no internet exposure)

An addendum to [04 — Deploy the Agent](04-deploy-agent.md) for the case where
**Jira Data Center runs in the same cluster** as the agent (different namespace)
and reaches the receiver **directly**, with no public ingress. This is the Brisa
topology:

```
Corporate net ─VPN─ Transit Gateway ─ VPC (EKS devtools)
                                          ├─ Jira DC  (namespace: <jira-ns>)
                                          │     └── POST ──┐  in-cluster, cross-namespace
                                          ├─ agents ns ◄───┘  http://agent-receiver.agents.svc.cluster.local/jira-webhook
                                          │     └─ receiver → run Job → Bedrock (eu-west-1, IRSA)
                                          └─ NAT ─→ GitLab (external, HTTPS)
```

Read [04](04-deploy-agent.md) first. This page only states the **deltas**.

← [Configure Jira](03-configure-jira.md) · Next → [Operations](05-operations.md)

---

## What changes vs the default path

| | Default (04) | This path (DC, in-cluster) |
|---|---|---|
| Jira flavor | Cloud or DC | **Data Center 10.x** |
| Webhook ingress | CloudFront → public NLB → prefix-list lock | **none** — Jira posts to in-cluster DNS |
| Receiver Service | LBC-managed NLB (`LoadBalancer`) | **`ClusterIP`** |
| Webhook URL | `https://<dist>.cloudfront.net/jira-webhook` | `http://agent-receiver.agents.svc.cluster.local/jira-webhook` |
| Trigger adapter | `TRIGGER=jira` | **`TRIGGER=jira-dc`** |
| Agent image | `jira-triage` | **`jira-triage-dc`** (REST v2, Bearer PAT, wiki comments) |
| Trigger + auth | Automation + shared-secret / HMAC | **System webhook + HMAC** (DC delivers + signs these) |
| Jira auth | Basic `email:token` | **Bearer PAT** (`JIRA_AUTH_SCHEME=basic` to fall back) |
| Actors / assignees | accountIds | **DC usernames** (`user.name`) |
| GitLab | in-cluster or external | **external via NAT** (`https://…`) |
| Bedrock | eu-west-1 (default) | eu-west-1 (unchanged) |
| Extra manifest | — | **ingress NetworkPolicy** (allow the Jira namespace) |

CloudFront, the LBC, the prefix-list origin lock, and the webhook-URL-drift
footgun all **go away** on this path.

## Step 1 — Provision IRSA (terraform), no CloudFront

Exactly [04 Step 1](04-deploy-agent.md#step-1--provision-irsa-and-optionally-cloudfront),
but **never set `listener_lb_dns`** — that keeps CloudFront disabled. You only
need the Bedrock IRSA role:

```bash
cd agent/deploy/terraform
cp example.tfvars terraform.tfvars   # name, region=eu-west-1, oidc_provider_arn
terraform init && terraform apply
terraform output -raw triage_bedrock_role_arn   # → namespace.yaml agent-runner SA
```

## Step 2 — Build and push the DC image

```bash
make agent-image AGENT=jira-triage-dc HARNESS=pi
# → <acct>.dkr.ecr.eu-west-1.amazonaws.com/agent:jira-triage-dc-pi
```

## Step 3 — Fill in the manifests (DC overlay)

The DC overlay lives in `agent/deploy/k8s/dc/`. Use **its** receiver +
ingress-netpol + config instead of the top-level ones; everything else
(`namespace.yaml`, `rbac.yaml`, `resourcequota.yaml`, `netpol.yaml`,
`secrets.yaml`) is shared with the default path.

```bash
cp agent/deploy/k8s/dc/config.example.yaml agent/deploy/k8s/config.yaml    # DC: usernames in assignees
cp agent/deploy/k8s/secrets.example.yaml   agent/deploy/k8s/secrets.yaml
```

- **`secrets.yaml`** — set:
  - `JIRA_API_TOKEN` = the bot's **DC Personal Access Token** (Profile → Personal
    Access Tokens). `JIRA_EMAIL` is the bot **username** (only consulted if you
    set `JIRA_AUTH_SCHEME=basic`; harmless otherwise).
  - `GITLAB_READ_TOKEN` = the read-only deploy token.
  - `WEBHOOK_HMAC_SECRET` = `openssl rand -hex 32` — the DC system-webhook path.
- **`namespace.yaml`** — `agent-runner` SA annotation = `triage_bedrock_role_arn`.
- **`agent/deploy/k8s/dc/receiver.yaml`** — set `image` + `AGENT_IMAGE` to your
  DC image; set `RUN_ENV`'s `GITLAB_BASE_URL` to the external GitLab HTTPS URL;
  set `AUTHORIZED_ACTORS` to the triggering **DC usernames**. `TRIGGER=jira-dc`
  and the `ClusterIP` Service are already set.
- **`agent/deploy/k8s/dc/ingress-netpol.yaml`** — set `<jira-namespace>` to the
  namespace Jira runs in (see the header note on finding/labeling it). If
  `JIRA_BASE_URL` for write-back is reached over the corporate ALB rather than
  in-cluster, set `JIRA_BASE_URL` in `secrets.yaml`/`receiver.yaml` accordingly.

## Step 4 — Apply

```bash
kubectl apply -f agent/deploy/k8s/namespace.yaml
kubectl apply -f agent/deploy/k8s/rbac.yaml
kubectl apply -f agent/deploy/k8s/resourcequota.yaml
kubectl apply -f agent/deploy/k8s/netpol.yaml              # run-pod egress fence (shared)
kubectl apply -f agent/deploy/k8s/dc/ingress-netpol.yaml   # receiver ingress: allow Jira ns
kubectl apply -f agent/deploy/k8s/config.yaml
kubectl apply -f agent/deploy/k8s/secrets.yaml
kubectl apply -f agent/deploy/k8s/dc/receiver.yaml         # DC receiver (ClusterIP, TRIGGER=jira-dc)

kubectl -n agents rollout status deploy/agent-receiver
```

## Step 5 — Register the Jira system webhook (DC)

In Jira admin (**System → WebHooks → Create**), per
[03 Trigger B](03-configure-jira.md#trigger-b--system-webhook-hmac-data-center--server):

- **URL:** `http://agent-receiver.agents.svc.cluster.local/jira-webhook`
- **Secret:** the `WEBHOOK_HMAC_SECRET` value.
- **Events:** `Issue: created`, `Issue: updated`.
- **JQL filter:** scope to the project, e.g. `project = OPS`.

> The in-cluster DNS name resolves from the Jira pods (same cluster). If Jira's
> egress is itself NetworkPolicy-fenced, allow it to reach the `agents` namespace
> on TCP 8080.

## Step 6 — Pre-launch verification (DC-specific)

The blocking checklist from [04](04-deploy-agent.md#pre-launch-verification-blocking)
applies, with these DC notes:

- [ ] **Reachability.** From a Jira pod (or a probe pod in the Jira namespace):
      `curl -s -o /dev/null -w '%{http_code}' http://agent-receiver.agents.svc.cluster.local/healthz`
      → `200`. If it hangs, the ingress NetworkPolicy namespace selector is wrong
      or the CNI isn't enforcing — check `kubectl get ns <jira-ns> --show-labels`.
- [ ] **Capture a real `X-Hub-Signature`.** Trigger one webhook and confirm the
      `sha256=` prefix matches `runtime/lib/auth.js` (`SIGNATURE_ALGO`). DC 10.x
      uses sha256; older majors may differ.
- [ ] **Real DC API shapes.** With the bot PAT against a throwaway issue, confirm
      the v2 request shapes (`scripts/jira.sh` in `jira-triage-dc`): comment is
      plain/wiki (not ADF), assignee is `{name}`, priority/issuetype/labels as
      v2. Fix the DC `jira.sh` if your instance differs.
- [ ] **Actor is the username.** Confirm the webhook payload's `user.name` (or
      `.key`) matches what you put in `AUTHORIZED_ACTORS` — a label-add from an
      unlisted user is dropped `unauthorized label actor`.
- [ ] **NetworkPolicy enforcement, concurrency, AWS Budget** — as in 04.

Next → [Operations](05-operations.md)
