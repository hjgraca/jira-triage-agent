# 03 (DC) — Configure Jira Data Center (customer admin, step by step)

A concrete, click-by-click guide for the **Jira Data Center / Server admin** (Jira
10.x) to set up everything the triage agent needs on the Jira side. This is the
DC-specific companion to [03 — Configure Jira](03-configure-jira.md); follow
**this** one for a Data Center instance.

Who does this: a **Jira administrator** (you said you're admin on Jira). It does
not touch the cluster — it's all in the Jira UI + a couple of `curl` checks.

What you'll create, in order:
1. A **bot user** for the agent + an **API token (PAT)**.
2. The **`triage` label** convention + the **allowed values** you'll let it write.
3. The **trigger** that calls the agent when someone adds the `triage` label —
   either a **System Webhook** or an **Automation rule** (this guide helps you
   pick, because DC webhooks have a signing caveat).

Have ready from the deploy side (the engineer gives you these):
- the **webhook URL** — for in-cluster deploy it's
  `http://agent-receiver.agents.svc.cluster.local/jira-webhook`
- the **shared secret** (`AUTOMATION_SHARED_SECRET`) or **HMAC secret**
  (`WEBHOOK_HMAC_SECRET`) — a random 32-byte hex string, generated once and used
  on BOTH sides. (`openssl rand -hex 32`)

← [Configure GitLab](02-configure-gitlab.md) · Next → [Deploy: DC in-cluster](04b-deploy-data-center-in-cluster.md)

---

## Step 1 — Create the bot user

The agent comments and edits Jira **as this user**, so make it a dedicated
account (not a person). Its username is also what the **loop guard** and the
**actor allowlist** key on.

1. **Jira Administration (⚙️) → User management → Create user.**
2. Fill in:
   - **Username:** e.g. `triage-bot` (record this — it's the `user.name` the agent
     uses; it goes in `AUTHORIZED_ACTORS` and config `assignees`).
   - **Full name:** e.g. `Triage Bot`.
   - **Email:** a real mailbox you control (for password reset).
3. Give it **only** the permissions it needs on the **test project** first
   (Project settings → Permissions, or via a permission scheme):
   - Browse Projects
   - Add Comments
   - Edit Issues
   - Assign Issues (only if you'll let it assign)
   - Transition Issues (only if you'll enable transitions)
4. Do **not** make it an admin.

**Exit check:** you can log in as `triage-bot` and see the test project.

---

## Step 2 — Create the bot's Personal Access Token (PAT)

The agent authenticates to the Jira REST API with a **PAT** (a bearer token),
which is the DC-native way and avoids storing the bot's password.

1. Log in as **`triage-bot`** (or have the bot owner do it).
2. **Profile (top-right avatar) → Personal Access Tokens → Create token.**
3. Name it `triage-agent`, set an expiry you'll rotate before (e.g. 90 days),
   **Create**, and **copy the token now** (it's shown once).
4. Hand this token to the deploy engineer — it becomes the `JIRA_API_TOKEN`
   Kubernetes secret. **Treat it like a password.**

> **If your instance has PATs disabled** (some orgs lock them down): skip this and
> tell the engineer to set `JIRA_AUTH_SCHEME=basic` — the agent will then use the
> bot **username + password** instead. PAT is preferred; basic is the fallback.

**Exit check (the engineer or you can run this):**
```bash
BASE=<your-jira-base-url>          # e.g. https://jira.example.internal
TOKEN=<the-PAT>
curl -sS "$BASE/rest/api/2/myself" \
  -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json' \
  | jq '{name, key, displayName}'
```
You should get the bot's `name`/`key` back (HTTP 200). Note: **DC uses `name`,
there is no `accountId`** — that `name` is what goes in the allowlist.

---

## Step 3 — Decide the allowed values (what the agent may write)

The agent **fails closed**: it can only set field values you explicitly list, so
even a maliciously-worded ticket can't make it set something you didn't approve.
Read the real values off a live ticket, then give them to the engineer for
`config.yaml`.

**Priorities and issue types** (exact names, case-sensitive):
```bash
curl -sS "$BASE/rest/api/2/issue/<SOME-KEY>?fields=priority,issuetype,labels" \
  -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json' \
  | jq '{priority:.fields.priority.name, issuetype:.fields.issuetype.name}'
```

**Workflow transitions** (id + name — only if you want the agent to move status):
```bash
curl -sS "$BASE/rest/api/2/issue/<SOME-KEY>/transitions" \
  -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json' \
  | jq '.transitions[] | {id, name}'
```

Decide and write down:
| Set | Your value | Notes |
|---|---|---|
| `labels` | e.g. `bug, enhancement, needs-info, ready-for-human, wontfix, needs-human` | the labels it may apply |
| `priorities` | the **exact** names from above | case-sensitive |
| `issuetypes` | the exact type names | |
| `assignees` | bot-poolable **usernames**, or empty | empty = it only *recommends* an owner, never assigns |
| `transitions` | transition **ids**, or empty | empty = it makes no status moves |

**Exit check:** you have all five lists with real values from your instance.

---

## Step 4 — Decide the trigger actors

Decide **which Jira usernames** are allowed to start a triage run by adding the
`triage` label. Anyone else who adds the label is ignored (this stops random
people from spending model budget).

- Give the deploy engineer the comma-separated **usernames** (e.g.
  `alice,bob,triage-leads`) → they go in `AUTHORIZED_ACTORS`.

**Exit check:** you have the list of trigger usernames.

---

## Step 5 — Create the trigger (pick ONE path)

This is the step with a real DC gotcha, so read the comparison first.

The agent's receiver accepts **either** of two proofs that a request is genuinely
from your Jira:
- an **HMAC signature** (`X-Hub-Signature: sha256=…`) over the body, **or**
- a **fixed shared-secret header** (`X-Triage-Token: <secret>`).

| | **Path A: System Webhook** | **Path B: Automation rule** |
|---|---|---|
| Where | Admin → System → WebHooks | Project/Global → Automation |
| Sends a real Jira changelog | ✅ yes | ✖ no (sends a custom body) |
| Can add a custom header | ✖ usually not | ✅ yes (`X-Triage-Token`) |
| Signs the body (HMAC) | **Only if your version has a webhook "Secret" field** — many DC versions do **not** | ✖ can't compute HMAC |
| Auth it can satisfy | HMAC **iff** the Secret field exists | shared-secret header |
| Reliability | high | high |

**The catch:** Jira DC system webhooks historically do **not** sign requests
(`X-Hub-Signature` is a GitHub/Bitbucket convention). Whether your Jira 10.x build
has a webhook **Secret** field that produces that header **must be confirmed on
your instance** (Step 6). If it doesn't, the HMAC path can't authenticate and you
should use **Path B (Automation rule + shared-secret header)** — which is the more
reliable choice on DC and is what we recommend unless you confirm webhook signing.

### Path A — System Webhook (use only if your version signs, see Step 6)

Set the HMAC secret on the cluster side first: the engineer sets
`WEBHOOK_HMAC_SECRET` (= `openssl rand -hex 32`) in the Kubernetes secret and
rolls the receiver.

1. **Administration (⚙️) → System → WebHooks → Create a WebHook.**
2. **Name:** `Triage Agent`.
3. **URL:** the webhook URL the engineer gave you
   (`http://agent-receiver.agents.svc.cluster.local/jira-webhook` for in-cluster).
4. **Secret:** paste the **same** `WEBHOOK_HMAC_SECRET` value. *(If there is no
   Secret field in your version, STOP — use Path B instead.)*
5. **Events:** check **Issue → created** and **Issue → updated**.
6. **JQL filter:** scope to the test project, e.g. `project = OPS`. (Keeps it from
   firing on every project.)
7. **Create.**

The agent only acts on `issue_created`, or an `issue_updated` whose changelog
shows the `triage` label was **just added** — so an unrelated edit won't trigger a
run.

### Path B — Automation rule + shared-secret header (recommended on DC)

Set the shared secret on the cluster side first: the engineer sets
`AUTOMATION_SHARED_SECRET` (= `openssl rand -hex 32`) in the Kubernetes secret and
rolls the receiver.

> Needs **Automation for Jira** (bundled in recent DC; if absent, ask your admin
> to enable the app, or use Path A).

1. **Project settings → Automation → Create rule** (or global Automation).
2. **Trigger:** **Field value changed** → field **Labels**.
   *(Optionally add a second rule with trigger **Issue created** for create-time
   triage.)*
3. **Condition:** **Issue fields condition** → field **Labels** → **contains** →
   value `triage`. (So it only fires when the triage label is present.)
4. **Action:** **Send web request**:
   - **Web request URL:** the webhook URL from the engineer.
   - **HTTP method:** `POST`.
   - **Web request body:** **Custom data**, with exactly:
     ```json
     {
       "webhookEvent": "automation:label-added",
       "user": { "name": "{{initiator.name}}" },
       "issue": { "key": "{{issue.key}}" }
     }
     ```
   - **Headers** (click *Add header* for each):
     | Header | Value |
     |---|---|
     | `Content-Type` | `application/json` |
     | `X-Triage-Token` | the `AUTOMATION_SHARED_SECRET` value |
     | `X-Triage-Delivery-Id` | `{{rule.id}}-{{issue.key}}-{{now.epochMillis}}` |
   - Leave **"Wait for response"** unchecked (the agent works asynchronously).
5. **Turn on** the rule.

`webhookEvent: automation:label-added` tells the receiver the event is eligible
(the rule's label condition is the real gate); `{{initiator.name}}` keeps the
actor allowlist (Step 4) in force; `X-Triage-Delivery-Id` lets a retried delivery
be deduplicated instead of double-triaged.

> ⚠️ **`{{initiator.name}}` must resolve to the DC username** in your Automation
> version. If your build exposes it as `{{initiator.key}}` or
> `{{initiator.accountId}}` instead, use whichever yields the **username/key** you
> listed in `AUTHORIZED_ACTORS` — confirm in Step 6's log line.

---

## Step 6 — Verify the trigger end to end (blocking, before real use)

Do this on the **test project** with the engineer watching the receiver log:

```bash
# the engineer runs this; one line appears per inbound webhook
kubectl -n agents logs -l app.kubernetes.io/name=agent-receiver -f \
  | grep -E '"msg":"(spawn|drop|reject)"'
```

1. As an **allowlisted user** (Step 4), **add the `triage` label** to a
   low/medium test ticket.
2. Read the receiver log line:
   - `"msg":"spawn" … "authVia":"hmac"` → Path A is working (your version signs).
   - `"msg":"spawn" … "authVia":"shared-secret"` → Path B is working.
   - `"msg":"reject","reason":"unauthenticated"` → the secret/signature didn't
     match. **On Path A this usually means your DC version does NOT sign — switch
     to Path B.** On Path B, re-check the `X-Triage-Token` value matches exactly.
   - `"msg":"drop","reason":"unauthorized label actor"` → the user isn't in
     `AUTHORIZED_ACTORS`, or the trigger sent the wrong `user.name` field (fix the
     smart-value, see the Step 5B warning).
   - `"msg":"drop","reason":"ineligible event"` → the event wasn't a create or a
     label-add (expected for unrelated edits).
3. Confirm in Jira: the ticket gets a comment starting with
   `> *This was generated by AI during triage.*`, fields set within your allowed
   sets, and the **`triage` label removed**.

**This is also where the two live-instance unknowns get settled:**
- **Does your DC sign webhooks?** The `authVia` line answers it definitively.
- **Do the REST v2 write shapes match?** If the agent's comment/field writes fail
  in the run log, the engineer adjusts `scripts/jira.sh` — but the bot PAT +
  `/rest/api/2` shapes used are standard DC, so this is usually clean.

---

## Quick reference — what you hand to the deploy engineer

| Item | From | Becomes |
|---|---|---|
| Bot **username** | Step 1 | part of `AUTHORIZED_ACTORS`; config `assignees` if poolable |
| Bot **PAT** | Step 2 | `JIRA_API_TOKEN` secret (or set `JIRA_AUTH_SCHEME=basic` + password) |
| Jira **base URL** | your instance | `JIRA_BASE_URL` |
| **Allowed values** (5 lists) | Step 3 | `config.yaml` |
| **Trigger usernames** | Step 4 | `AUTHORIZED_ACTORS` |
| Which **trigger path** (A/B) + the **secret** | Steps 5–6 | `WEBHOOK_HMAC_SECRET` or `AUTOMATION_SHARED_SECRET` |

Next → [Deploy: DC in-cluster](04b-deploy-data-center-in-cluster.md)
