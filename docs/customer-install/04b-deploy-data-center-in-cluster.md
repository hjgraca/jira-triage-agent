# 04b — Deploy: Jira Data Center, in-cluster (no internet exposure)

For the common DC topology — **Jira Data Center runs in the same cluster** as the
agent (different namespace) and reaches the receiver **directly**, with no public
ingress:

```
Corporate net ─VPN─ Transit Gateway ─ VPC (EKS devtools)
                                          ├─ Jira DC  (namespace: <jira-ns>)
                                          │     └── POST ──┐  in-cluster, cross-namespace
                                          ├─ agents ns ◄───┘  http://agent-receiver.agents.svc.cluster.local/jira-webhook
                                          │     └─ receiver → run Job → Bedrock (eu-west-1, IRSA)
                                          └─ NAT ─→ GitLab (external, HTTPS)
```

> **The full walkthrough is [00 — Complete Guide](00-COMPLETE-GUIDE.md)** —
> AWS/Bedrock, image, GitLab, Jira DC, manifests, apply, and verification, top to
> bottom. **Follow that.** This page is a quick orientation to the key facts of the
> in-cluster deploy; it does not repeat the steps.

← [Configure Jira](03-configure-jira-data-center.md) · Next → [Operations](05-operations.md)

---

## Key facts of this deploy

| | |
|---|---|
| Jira flavor | **Data Center 10.x**, in the same cluster |
| Webhook ingress | **none** — Jira posts to the in-cluster Service DNS, no public endpoint |
| Receiver Service | **`ClusterIP`** |
| Webhook URL | `http://agent-receiver.agents.svc.cluster.local/jira-webhook` |
| Trigger adapter | **`TRIGGER=jira-dc`** |
| Agent image | **`jira-triage-dc`** (REST v2, Bearer PAT, wiki comments) |
| Trigger + auth | **System webhook + HMAC**, or Automation rule + shared-secret |
| Jira auth | **Bearer PAT** (`JIRA_AUTH_SCHEME=basic` to fall back) |
| Actors / assignees | **DC usernames** (`user.name`) |
| GitLab | **external via NAT** (`https://…`) |
| Cloud provisioning | **one `aws` CLI script** (`overlays/eks-bedrock/irsa-bedrock.sh`) for the single Bedrock IAM role |
| Extra manifest | **ingress NetworkPolicy** (allow the Jira namespace) |

It's **`kubectl` + `docker` + one small script** — nothing to stand up in a
cluster you already operate.

## Where the DC steps live

Everything below is in [00 — Complete Guide](00-COMPLETE-GUIDE.md), by phase:

| Step | In the Complete Guide |
|---|---|
| Bedrock IRSA role (`overlays/eks-bedrock/irsa-bedrock.sh`) | Phase 1 |
| Build + push the **`jira-triage-dc`** image | Phase 3 |
| Fill the DC overlay manifests (`agent/deploy/k8s/base/` + `overlays/`) | Phase 4 |
| Apply, in order (incl. the ingress NetworkPolicy) | Phase 6.1 |
| In-cluster reachability + the trigger | Phase 6.2–6.3 |
| The two live-only checks (does DC sign? do v2 shapes match?) | Phase 7 + "Two things only a live instance can confirm" |

The Jira-side admin setup (bot user, PAT, allowed values, trigger) is its own
guide: **[03 — Configure Jira Data Center](03-configure-jira-data-center.md)**.

Next → [Operations](05-operations.md)
