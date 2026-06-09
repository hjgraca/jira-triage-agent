# 03 — Configure Jira

This sets up the agent's Jira identity, the values it's allowed to write, and the
**trigger** that calls the agent when a `triage` label is added.

The trigger differs by Jira flavor, and the listener supports **both** — pick the
section that matches your deployment:

- **Jira Cloud** (`*.atlassian.net`) → [Trigger A: Automation rule](#trigger-a--jira-automation-rule-cloud)
- **Jira Data Center / Server** → [Trigger B: System webhook (HMAC)](#trigger-b--system-webhook-hmac-data-center--server)

← [Configure GitLab](02-configure-gitlab.md) · Next → [Deploy the agent](04-deploy-agent.md)

---

## 1. Create a dedicated bot account

Create a **separate** Atlassian/Jira user for the agent (e.g.
`triage-bot@yourco.com`). The agent comments and edits as this user, and its
`accountId` is what the **loop guard** keys on (so it never re-triggers on its own
comments). Using a human's account would break the loop guard and muddy the audit
trail.

Generate an API token:

- **Cloud:** <https://id.atlassian.com/manage-profile/security/api-tokens>
- **Data Center / Server:** a Personal Access Token (Profile → Personal Access
  Tokens), or use the account password if PATs are unavailable.

These become the `JIRA_EMAIL` and `JIRA_API_TOKEN` keys in the Kubernetes secret.

Grant the bot only what it needs in the target project: **add comments, edit
issues, transition issues** (if you enable transitions), and **browse**.

## 2. Find the bot's accountId (for the loop guard + allowlist)

```bash
BASE=https://<your-site>.atlassian.net      # or your DC base URL
EMAIL=triage-bot@yourco.com
TOKEN=<bot-api-token>
AUTH=$(printf '%s:%s' "$EMAIL" "$TOKEN" | base64)

curl -sS "$BASE/rest/api/3/myself" -H "Authorization: Basic $AUTH" -H 'Accept: application/json' \
  | jq '{accountId, displayName, emailAddress}'
```

You will
want the **accountIds of the humans** allowed to trigger the agent (next step).

## 3. Define allowed-value sets

The agent **fails closed** — it can only write field values you list. Confirm the
real values against your project and put them in `agent/deploy/k8s/base/config.yaml`
(copy from `agent/deploy/k8s/base/config.example.yaml`).

```bash
# Inspect a real issue to read the live priority/issue-type names:
curl -sS "$BASE/rest/api/3/issue/<KEY>?fields=priority,issuetype,labels" \
  -H "Authorization: Basic $AUTH" -H 'Accept: application/json' \
  | jq '{priority: .fields.priority.name, issuetype: .fields.issuetype.name}'
```

`config.json` keys:

| Key | Meaning |
|---|---|
| `labels` | The curated label set the agent may apply. |
| `priorities` | Exact Jira priority names for your scheme. |
| `issuetypes` | Exact issue-type names. **Note:** if your project has no `Bug` type, "bug" is a *category label*, not an issue type. |
| `assignees` | accountIds of a real on-call pool **only**. Empty `[]` = the agent never auto-assigns (it recommends an owner in the comment instead). |
| `transitions` | Allowed workflow transition IDs. Empty `[]` = the agent makes no status moves. |

## 4. Authorized trigger actors

Decide which Jira accountIds may trigger a run by adding the `triage` label, and
set `AUTHORIZED_ACTORS` (comma-separated accountIds) in
`agent/deploy/k8s/overlays/aws-cloudfront/receiver.yaml`. This stops anyone-who-can-edit-labels from
spending Bedrock tokens. The trigger passes the initiator's accountId, and the
listener drops label-adds from anyone not on this list (R6b).

---

## Trigger A — Jira Automation rule (Cloud)

> **Why this and not a system webhook on Cloud?** Jira Cloud frequently does
> **not** deliver system webhooks (`/rest/webhooks/1.0/`) to arbitrary external
> URLs, even with a valid HMAC. Automation rules use a different, reliable egress
> path. The catch: Automation's *Send web request* **can't compute an HMAC** over
> the body — so it authenticates with a fixed shared-secret header instead.

**Prereq:** set `AUTOMATION_SHARED_SECRET` in `agent/deploy/k8s/base/secrets.yaml`
(`openssl rand -hex 32`), apply the secret, and roll the deployment. This becomes
the `AUTOMATION_SHARED_SECRET` the listener checks (constant-time) against the
`X-Triage-Token` header.

In **Project settings → Automation → Create rule** (or global Automation):

1. **Trigger:** *Field value changed* → field **Labels**.
   (Add a second rule with *Issue created* if you also want create-time triage.)
2. **Condition:** *Issue fields condition* → **Labels** *contains* `triage`.
   Keeps the rule from firing on unrelated label edits.
3. **Action:** *Send web request*:
   - **URL:** your webhook URL — the `triage_webhook_url` terraform output
     (`https://<dist>.cloudfront.net/jira-webhook`), or your own ALB URL.
     > ⚠️ **Re-check this after any `terraform apply` that recreates CloudFront.**
     > A recreated distribution gets a **new** `*.cloudfront.net` domain, so this
     > hand-entered URL goes stale and the rule POSTs to a dead host. The symptom
     > is silent: **no receiver log at all**, and the rule's audit log shows
     > *Send web request* → `500` with a **Squid** "could not be retrieved" page
     > (that's Jira's egress proxy failing to reach the old host — not the
     > receiver). Re-run `terraform -chdir=workshop/terraform output -raw
     > triage_webhook_url` and update this field to match.
   - **HTTP method:** `POST`
   - **Headers:**
     | Header | Value |
     |---|---|
     | `Content-Type` | `application/json` |
     | `X-Triage-Token` | `<your AUTOMATION_SHARED_SECRET>` |
     | `X-Triage-Delivery-Id` | `{{rule.id}}-{{issue.key}}-{{issue.fields.updated}}` |
   - **Web request body:** *Custom data*:
     ```json
     {
       "webhookEvent": "automation:label-added",
       "user": { "accountId": "{{initiator.accountId}}" },
       "issue": { "key": "{{issue.key}}" }
     }
     ```
   - Leave **"Wait for response"** unchecked — the listener acks fast and works
     async.

The `X-Triage-Delivery-Id` is a stable id so a retried delivery is **deduped**,
not double-triaged. `webhookEvent: automation:label-added` tells the listener the
event is eligible by construction (the rule's label condition is the gate), while
`initiator.accountId` keeps the actor allowlist (R6b) in force.

**Test it:** add the `triage` label to a ticket and watch the listener log a
`spawn ... authVia:"shared-secret"` line — see [Operations](05-operations.md#verify).

---

## Trigger B — System webhook (HMAC; Data Center / Server)

On DC/Server, system webhooks deliver reliably and sign each request with an
HMAC, so this is the stronger path there.

**Prereq:** set `WEBHOOK_HMAC_SECRET` in `agent/deploy/k8s/base/secrets.yaml`
(`openssl rand -hex 32`), apply, and roll the deployment. Use the **same** value
as the webhook's secret below. This becomes `WEBHOOK_HMAC_SECRET`, which the
listener validates against the `X-Hub-Signature` header in constant time.

Create a **system** webhook (not a dynamic/Connect webhook) in Jira admin
(**System → WebHooks**) or via `POST /rest/webhooks/1.0/webhook`:

- **URL:** your webhook URL (the `triage_webhook_url` output, or your ALB URL).
- **Secret:** the `WEBHOOK_HMAC_SECRET` value.
- **Events:** `Issue: created`, `Issue: updated`.
- **JQL filter (recommended):** scope to the project, e.g. `project = KAN`.

The listener's eligibility logic accepts `jira:issue_created`, and
`jira:issue_updated` **only when** the changelog shows the `triage` label was
just added — so an unrelated update won't spawn a run.

**Test it:** add the `triage` label and watch for a `spawn ... authVia:"hmac"`
log line.

> **Capture a real signature before trusting the 401 path.** The listener assumes
> the `sha256=` prefix. Before going live, trigger one real webhook and confirm
> the actual `X-Hub-Signature` algorithm/prefix matches — see the pre-launch
> checklist in [Deploy](04-deploy-agent.md#pre-launch-verification-blocking).

---

## Which secret do I need?

| Jira flavor | Trigger | Secret key to set |
|---|---|---|
| Cloud | Automation rule | `AUTOMATION_SHARED_SECRET` |
| Data Center / Server | System webhook | `WEBHOOK_HMAC_SECRET` |

You only need the one for your path; the receiver enables a path only when its
secret is set. (Setting both is fine — e.g. migrating Cloud → DC.) The key name
**is** the env var the receiver reads — the secret is loaded via `envFrom`.

Next → [Deploy the agent](04-deploy-agent.md)
