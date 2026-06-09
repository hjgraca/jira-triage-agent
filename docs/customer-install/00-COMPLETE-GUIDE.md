# Complete Deployment Guide — Jira Triage Agent (Jira DC in-cluster)

**One document, start to finish.** Everything to take the agent from nothing to a
working end-to-end triage in the customer's infrastructure: AWS/Bedrock, EKS,
ECR, the image, GitLab, Jira Data Center, the manifests, and the verification.
No other doc required — the deeper references are linked where useful, but you can
follow this top to bottom.

## The target (what we're building)

```
Corporate net ─VPN─ Transit Gateway ─ VPC (EKS "devtools" cluster)
                                          ├─ Jira DC 10.x   (namespace: <jira-ns>)
                                          │     │ adds "triage" label → webhook
                                          │     ▼  http://agent-receiver.agents.svc.cluster.local/jira-webhook
                                          ├─ agents namespace
                                          │     receiver (ClusterIP) → 1 Kubernetes Job per event
                                          │       → pi (coding agent) → Bedrock (eu-west-1, IRSA)
                                          │       → reads GitLab (read-only) → writes the Jira ticket back
                                          └─ NAT ─→ GitLab (external, HTTPS)
```

- **No internet exposure** — Jira reaches the receiver over in-cluster DNS.
- **No Terraform, no `make` required, no `workshop/`** — `kubectl` + `docker` +
  one small script. (A convenience `Makefile` ships too; raw commands are given.)
- **One IAM role** is the only cloud resource (for Bedrock, via IRSA).

## Roles (who does what)

- **YOU (deploying engineer)** — AWS account work, image build, manifests, kubectl.
- **CUSTOMER ADMIN** — Jira admin + GitLab admin tasks. (You may be both; the
  labels just show where each action happens.) **You will not need access to
  their GitLab or cluster beyond your own kubeconfig** — where a step is theirs,
  it's marked.

## Tools you need on your machine

```bash
kubectl version --client && aws --version \
  && docker buildx version && jq --version && openssl version
```
- `kubectl` (matching the cluster), `aws` CLI v2 (logged into the cluster's
  account), `docker` with `buildx`, `jq`, `openssl`.
- **No Terraform, no `eksctl`** — the one IAM role is created by raw `aws` calls.

## Values to collect FIRST (these unblock everything)

Fill this table before starting — every placeholder below comes from it:

| # | Value | Example | Used in |
|---|---|---|---|
| 1 | EKS cluster name | `devtools` | Phase 2, 4 |
| 2 | AWS region | `eu-west-1` | everywhere |
| 3 | Bedrock model id | `eu.anthropic.claude-sonnet-4-6` | Phase 1, 4 |
| 4 | Image registry + repo (ECR, Nexus, Harbor, …) | `nexus.corp:8891/triage-agent` | Phase 3 |
| 5 | Jira base URL | `https://jira.example.internal` | Phase 5, 6 |
| 6 | Jira namespace (where Jira pods run) | `jira` | Phase 6 |
| 7 | GitLab base URL (external, via NAT) | `https://gitlab.example.internal` | Phase 4 |
| 8 | Bot username | `triage-bot` | Phase 5, 6 |
| 9 | Trigger usernames (who may add the label) | `alice,bob` | Phase 6 |
| 10 | Test project key | `OPS` | Phase 7 |
| 11 | Does the VPC CNI enforce NetworkPolicy? | yes/no/unsure | Phase 6 |

---

# Phase 1 — AWS / Bedrock

### 1.1 (CUSTOMER/YOU, AWS console) — Enable Bedrock model access

In the cluster's AWS account, region **eu-west-1**: **Bedrock → Model access →**
request/enable **Claude Sonnet 4.x** (the `eu.anthropic.claude-sonnet-4-6`
inference profile keeps inference in the EU).

**Verify:**
```bash
aws bedrock list-foundation-models --region eu-west-1 \
  --query "modelSummaries[?contains(modelId,'claude-sonnet-4')].modelId" --output text
```
You should see the model id, and the console shows **Access granted**.

### 1.2 (YOU) — Create the Bedrock IRSA role (one script, no Terraform)

The agent calls Bedrock via IRSA: the `agent-runner` ServiceAccount assumes an
IAM role whose policy is scoped to exactly one model. This is the **only** cloud
resource. From the repo root:

```bash
CLUSTER=<#1> REGION=eu-west-1 \
  agent/deploy/k8s/dc/irsa-bedrock.sh
```

Raw `aws` CLI only — **no `eksctl`, no Terraform**. It creates the
least-privilege policy (scoped to the model, never `*`), associates the cluster
OIDC provider if needed, binds the role to `agents:agent-runner`, and prints:
```
✅ IRSA role ready:
   arn:aws:iam::<acct>:role/<cluster>-triage-bedrock
```
**Record that ARN** — it goes into `namespace.yaml` in Phase 4.

---

# Phase 2 — Point kubectl at the cluster

```bash
aws eks update-kubeconfig --region eu-west-1 --name <#1>
kubectl get ns        # you should see the Jira namespace and (after Phase 4) agents
```

---

# Phase 3 — Build and push the image (any registry)

The image is built in **three layers** (engine → harness CLI → the one agent),
`linux/amd64` to match EKS nodes. Build context is the `agent/` directory. It
pushes to **whatever registry you point it at** — ECR, Sonatype Nexus, Harbor,
GHCR, Docker Hub, a self-hosted registry. `<#4>` is your full registry + repo
path (no tag), e.g. `nexus.corp:8891/triage-agent` or
`111122223333.dkr.ecr.eu-west-1.amazonaws.com/triage-agent`.

### 3.1 — Log in to your registry

```bash
docker login <#4-host>          # your registry's host — it'll prompt for creds
```
> **ECR?** Use the bundled convenience instead (creates the repo + logs in):
> ```bash
> cd agent && make ecr-login REGION=eu-west-1 ECR_REPO=triage-agent && cd ..
> ```
> Any other registry (Nexus/Harbor/…): a plain `docker login <host>` is all you
> need — the cluster must also be able to reach and pull from it (see Phase 4 for
> the pull-secret if it's private).

### 3.2 — Build + push (pick ONE)

**Option A — the shipped Makefile** (from the `agent/` directory):
```bash
cd agent
make agent-image AGENT=jira-triage-dc HARNESS=pi REGISTRY=<#4>
cd ..
# → pushes <#4>:jira-triage-dc-pi
```

**Option B — raw docker** (no `make`):
```bash
REPO=<#4>
docker buildx build --platform linux/amd64 \
  -f agent/deploy/docker/base.Dockerfile -t agent-base:local --load agent
docker buildx build --platform linux/amd64 \
  -f agent/deploy/docker/pi.Dockerfile --build-arg BASE=agent-base:local -t agent-pi:local --load agent
docker buildx build --platform linux/amd64 \
  -f agent/agents/jira-triage-dc/Dockerfile --build-arg BASE=agent-pi:local -t "$REPO:jira-triage-dc-pi" --push agent
```

**Verify** the tag is in the registry (registry-agnostic):
```bash
docker buildx imagetools inspect <#4>:jira-triage-dc-pi >/dev/null && echo "pushed ✅"
```

> **Iterating later?** The tag is fixed, and Kubernetes caches fixed tags
> (`IfNotPresent`). When you rebuild after editing a prompt, **bump the tag**
> (`AGENT_IMAGE_TAG=jira-triage-dc-pi-v2` or `-t "$REPO:...-v2"`) and update both
> image refs in the receiver, or the nodes keep the stale image. See
> [GUIDE-configure-and-change-the-prompt.md](GUIDE-configure-and-change-the-prompt.md).

---

# Phase 4 — Configure GitLab + fill the manifests

### 4.1 (CUSTOMER, GitLab admin) — Create a read-only token

GitLab → **Project (or Group) → Settings → Repository → Deploy tokens**:
- **Scopes:** `read_repository` (+ `read_api` if you want richer routing).
- Copy the token → it becomes `GITLAB_READ_TOKEN`.

The agent only ever **reads** GitLab (to route tickets and analyze which repos a
feature touches). Never give it a write or full-API token.

### 4.2 (YOU) — Create the config and secret files from templates

```bash
cp agent/deploy/k8s/dc/config.example.yaml agent/deploy/k8s/config.yaml
cp agent/deploy/k8s/secrets.example.yaml   agent/deploy/k8s/secrets.yaml
```
(Both are gitignored — they hold real values and never get committed.)

### 4.3 — Generate the webhook secret

```bash
openssl rand -hex 32      # → use as WEBHOOK_HMAC_SECRET *or* AUTOMATION_SHARED_SECRET
```
Keep this value — you'll paste the **same** string into Jira in Phase 6. (Which of
the two keys you use depends on the trigger path you pick in Phase 6; if unsure,
fill both with `openssl rand -hex 32` values — extra ones are ignored.)

### 4.4 — Edit the four files

**`agent/deploy/k8s/secrets.yaml`** — the only long-lived credentials:
| Key | Value |
|---|---|
| `JIRA_API_TOKEN` | the bot **PAT** from Phase 5.2 |
| `JIRA_EMAIL` | the bot **username** (only used if `JIRA_AUTH_SCHEME=basic`) |
| `GITLAB_READ_TOKEN` | the token from 4.1 |
| `WEBHOOK_HMAC_SECRET` | the 4.3 value (System-Webhook path) |
| `AUTOMATION_SHARED_SECRET` | the 4.3 value (Automation-rule path) |

**`agent/deploy/k8s/config.yaml`** — what the agent is ALLOWED to write (it fails
closed — anything not listed is refused). Fill from real values you read in
Phase 5.3. `assignees` are **DC usernames** (or leave `[]` so it only recommends).

**`agent/deploy/k8s/namespace.yaml`** — set the `agent-runner` SA annotation:
```yaml
    eks.amazonaws.com/role-arn: <the role ARN from Phase 1.2>
```

**`agent/deploy/k8s/dc/receiver.yaml`** — set:
- `image:` and `AGENT_IMAGE` → `<#4>:jira-triage-dc-pi` (both, same value)
- in `RUN_ENV`, `GITLAB_BASE_URL=<#7>` (the external GitLab HTTPS URL)
- `AUTHORIZED_ACTORS` → `<#9>` (DC usernames allowed to trigger)
- (already set: `TRIGGER=jira-dc`, `MODEL=eu.anthropic.claude-sonnet-4-6`,
  `AWS_REGION=eu-west-1`, ClusterIP Service)
- If PATs are disabled (Phase 5.2), append `,JIRA_AUTH_SCHEME=basic` to `RUN_ENV`.
- **Private registry (Nexus/Harbor/…)?** Create a pull secret and wire it so both
  the receiver and the run Jobs can pull:
  ```bash
  kubectl -n agents create secret docker-registry regcred \
    --docker-server=<#4-host> --docker-username=<user> --docker-password=<pass>
  ```
  then uncomment `imagePullSecrets:` (pod spec) **and** `IMAGE_PULL_SECRET=regcred`
  (env) in `receiver.yaml`. Skip this for public images or ECR pulled via the node
  role.

**`agent/deploy/k8s/dc/ingress-netpol.yaml`** — replace `<jira-namespace>` with
`<#6>`. If that namespace has no `kubernetes.io/metadata.name` label, label it:
```bash
kubectl label namespace <#6> kubernetes.io/metadata.name=<#6> --overwrite
```

**Validate before applying:**
```bash
for f in agent/deploy/k8s/dc/*.yaml agent/deploy/k8s/config.yaml agent/deploy/k8s/namespace.yaml; do
  kubectl apply --dry-run=client -f "$f" >/dev/null && echo "ok $f"; done
grep -RN "REPLACE_ME\|<REGISTRY>\|<ACCT>\|<ACCOUNT_ID>\|<NAME>\|<jira-namespace>\|<your-gitlab-host>\|<dc-username\|<#" \
  agent/deploy/k8s/config.yaml agent/deploy/k8s/secrets.yaml agent/deploy/k8s/namespace.yaml \
  agent/deploy/k8s/dc/receiver.yaml agent/deploy/k8s/dc/ingress-netpol.yaml \
  && echo "↑ placeholders still present — fix them" || echo "no placeholders left ✅"
```

---

# Phase 5 — Configure Jira Data Center (CUSTOMER admin)

Full detail: [03 — Configure Jira Data Center](03-configure-jira-data-center.md).
The essentials:

### 5.1 — Create the bot user
Jira Admin (⚙️) → **User management → Create user**. Username `<#8>` (e.g.
`triage-bot`). Grant on the test project only: Browse, Add Comments, Edit Issues
(+ Assign/Transition if you'll use them). **Not** an admin.

### 5.2 — Create the bot's Personal Access Token
Log in as the bot → **Profile → Personal Access Tokens → Create token**. Copy it
once → this is `JIRA_API_TOKEN`. (If PATs are disabled org-wide, skip this and use
the bot password with `JIRA_AUTH_SCHEME=basic`.)

**Verify (DC uses `name`, no accountId):**
```bash
curl -sS "<#5>/rest/api/2/myself" -H "Authorization: Bearer <PAT>" | jq '{name,key,displayName}'
```

### 5.3 — Read the real allowed values (for config.yaml in 4.4)
```bash
BASE=<#5>; TOKEN=<PAT>
curl -sS "$BASE/rest/api/2/issue/<a-real-key>?fields=priority,issuetype" \
  -H "Authorization: Bearer $TOKEN" | jq '{priority:.fields.priority.name, type:.fields.issuetype.name}'
curl -sS "$BASE/rest/api/2/issue/<a-real-key>/transitions" \
  -H "Authorization: Bearer $TOKEN" | jq '.transitions[] | {id,name}'
```
Record the exact (case-sensitive) priority names, issue types, and transition ids.

---

# Phase 6 — Apply to the cluster + wire the trigger

### 6.1 (YOU) — Apply the manifests, in order

```bash
kubectl apply -f agent/deploy/k8s/namespace.yaml      # ns + 2 ServiceAccounts (agent-runner has the IRSA annotation)
kubectl apply -f agent/deploy/k8s/rbac.yaml           # receiver may create Jobs
kubectl apply -f agent/deploy/k8s/resourcequota.yaml  # concurrency cap
kubectl apply -f agent/deploy/k8s/netpol.yaml         # run-pod egress fence
kubectl apply -f agent/deploy/k8s/dc/ingress-netpol.yaml   # receiver ingress: allow the Jira ns
kubectl apply -f agent/deploy/k8s/config.yaml         # allowed-value sets
kubectl apply -f agent/deploy/k8s/secrets.yaml        # credentials
kubectl apply -f agent/deploy/k8s/dc/receiver.yaml    # the receiver (ClusterIP, TRIGGER=jira-dc)

kubectl -n agents rollout status deploy/agent-receiver
```
(Or, from `agent/`: `make agent-deploy-dc` runs the same sequence.)

**Verify the receiver is up:**
```bash
kubectl -n agents logs -l app.kubernetes.io/name=agent-receiver --tail=5
# → a "listening" line with "trigger":"jira-dc"
```

### 6.2 — In-cluster reachability (from the Jira namespace)
```bash
kubectl -n <#6> run probe --rm -it --restart=Never --image=curlimages/curl -- \
  curl -s -o /dev/null -w '%{http_code}\n' \
  http://agent-receiver.agents.svc.cluster.local/healthz      # expect 200
```
If it hangs: the ingress NetworkPolicy namespace selector is wrong, or the CNI
isn't enforcing policy (value #11) — fix before continuing.

### 6.3 (CUSTOMER admin) — Create the trigger

Jira DC system webhooks often **don't** sign requests, so there are two paths.
Full walkthrough + the signing caveat: [03-configure-jira-data-center.md → Step 5](03-configure-jira-data-center.md).

**Path B — Automation rule + shared secret (recommended on DC):**
1. **Project settings → Automation → Create rule.**
2. **Trigger:** *Field value changed* → **Labels**.
3. **Condition:** *Issue fields condition* → **Labels** *contains* `triage`.
4. **Action:** *Send web request*:
   - **URL:** `http://agent-receiver.agents.svc.cluster.local/jira-webhook`
   - **Method:** `POST`
   - **Custom data** body:
     ```json
     { "webhookEvent": "automation:label-added",
       "user": { "name": "{{initiator.name}}" },
       "issue": { "key": "{{issue.key}}" } }
     ```
   - **Headers:** `Content-Type: application/json`,
     `X-Triage-Token: <AUTOMATION_SHARED_SECRET>`,
     `X-Triage-Delivery-Id: {{rule.id}}-{{issue.key}}-{{now.epochMillis}}`
   - **Wait for response:** unchecked.
5. **Turn on** the rule.

**Path A — System Webhook (use only if your version has a "Secret" field):**
Admin → **System → WebHooks → Create**; URL as above; **Secret** =
`WEBHOOK_HMAC_SECRET`; **Events:** Issue created + updated; **JQL:** `project = <#10>`.

---

# Phase 7 — End-to-end test

### 7.1 — Watch the receiver while you trigger
```bash
kubectl -n agents logs -l app.kubernetes.io/name=agent-receiver -f \
  | grep -E '"msg":"(spawn|drop|reject)"'
```
As an **allowlisted user (#9)**, add the `triage` label to a low/medium ticket in
the test project (#10). Read the log line:

| Log line | Meaning |
|---|---|
| `"msg":"spawn" … "authVia":"shared-secret"` | ✅ Path B working |
| `"msg":"spawn" … "authVia":"hmac"` | ✅ Path A working (your version signs) |
| `"msg":"reject","reason":"unauthenticated"` | secret/signature mismatch — on Path A this usually means your DC doesn't sign → switch to Path B; on Path B re-check `X-Triage-Token` |
| `"msg":"drop","reason":"unauthorized label actor"` | the user isn't in `AUTHORIZED_ACTORS`, or the rule sent the wrong `user.name` |
| `"msg":"drop","reason":"ineligible event"` | not a create/label-add (expected for unrelated edits) |

### 7.2 — Watch the run and confirm in Jira
```bash
kubectl -n agents get jobs --sort-by=.metadata.creationTimestamp | tail -3
kubectl -n agents logs -l app.kubernetes.io/name=agent-run --tail=120 --prefix
```
**Ground truth is the ticket:** it gets a comment starting
`> *This was generated by AI during triage.*`, fields set within your allowed
sets, and the `triage` label **removed**.

### 7.3 — Check the gates
- A **high-severity** ticket → gets `needs-human` + a recommendation comment, **no**
  field writes (the severity gate).
- A **non-allowlisted** user adding the label → `drop unauthorized label actor`.

---

# Phase 8 — Before "go live"

- [ ] **AWS Budget / Bedrock quota** as the cumulative cost ceiling (there's no
      in-app daily counter).
- [ ] **`pods` quota** in `resourcequota.yaml` tuned (`= receiver replicas + max
      concurrent runs`).
- [ ] **NetworkPolicy enforcement** confirmed (value #11). If off, the ingress
      lock + egress fence are inert — document the accepted risk; auth still gates.
- [ ] **Credential rotation** owner + schedule (≤90 days: PAT, GitLab token, HMAC
      secret). To rotate: edit `secrets.yaml`, `kubectl apply`, then
      `kubectl -n agents rollout restart deploy/agent-receiver`.
- [ ] **Widen the trigger** (JQL or rule scope) from the test project to the real
      scope only after 7.1–7.3 pass.

---

# Changing the agent's behavior later

Two speeds (full guide: [GUIDE-configure-and-change-the-prompt.md](GUIDE-configure-and-change-the-prompt.md)):

- **Fast (no rebuild):** edit `config.yaml` (allowed values) or `dc/receiver.yaml`
  env → `kubectl apply` (+ `rollout restart` for receiver env). The next run uses it.
- **Slow (rebuild):** edit `agents/jira-triage-dc/SKILL.md` (the prompt/rubric) or
  the `scripts/*.sh` → rebuild the image **with a bumped tag** → update both image
  refs in `dc/receiver.yaml` → `kubectl apply` + `rollout restart`.

Test changes locally without a cluster:
```bash
cd agent && make test        # or: (cd runtime && node --test) && bash agents/jira-triage-dc/tests/run.sh
```

---

# Pause / rollback

| To… | Run |
|---|---|
| Stop new runs now | `kubectl -n agents scale deploy/agent-receiver --replicas=0` |
| Stop deliveries | disable the Jira Automation rule / system webhook |
| Remove the agent | `kubectl delete ns agents` |
| Remove the IAM role | `aws iam detach-role-policy --role-name <#1>-triage-bedrock --policy-arn <policy-arn>` then `aws iam delete-role --role-name <#1>-triage-bedrock` (and `delete-policy` if unused) |

The agent only **reads** GitLab and writes to tickets within allowed-value sets —
rollback has no data-loss surface beyond comments/labels on test tickets.

---

# Two things only a live instance can confirm (do them in Phase 7)

1. **Does your Jira DC sign webhooks?** The `authVia` line in 7.1 answers it — if a
   known-good delivery is `reject`ed on Path A, your version doesn't sign; use
   Path B.
2. **Do the REST v2 write shapes match your instance?** If the run log (7.2) shows
   the comment/field writes failing, adjust `agents/jira-triage-dc/scripts/jira.sh`
   — but it uses standard DC `/rest/api/2` shapes (Bearer PAT, plain/wiki comment,
   `{name}` assignee), so this is usually clean.

---

# Critical path — what blocks what

```
Values ─┬─ Phase 1.1 Bedrock access ────────┐
        ├─ Phase 1.2 irsa-bedrock.sh (role) ─┐
        ├─ Phase 4.1 GitLab token            ├─ 4 fill ─ 6.1 apply ─ 6.2 reach ─ 7 e2e ─ 8 backstops
        └─ Phase 5 Jira bot/PAT + HMAC ──────┘                       └ 6.3 trigger ┘
Phase 3 image ──────────────────────────────────────────┘
```

The two hard, **customer-gated** blockers are **Bedrock access (1.1)** and the
**Jira bot + PAT (5)** — request both at the very start so they don't stall you.
The two checks that can only pass against the live instance are **in-cluster
reachability (6.2)** and **real signature + v2 shapes** (the two items in the
section just above) — budget time for one fix iteration on each.

---

## Appendix — the file map

```
agent/
  Makefile                         make agent-image | test | agent-deploy-dc  (run from agent/)
  runtime/                         the engine (receiver.js, run.js, trigger/, harness/, lib/)
  agents/jira-triage-dc/           THE DC AGENT — SKILL.md (prompt/rubric), scripts/jira.sh+gitlab.sh
  deploy/
    docker/                        base + pi/kiro/opencode Dockerfiles
    k8s/                           namespace, rbac, resourcequota, netpol  (shared)
      config.example.yaml          → copy to config.yaml (allowed values)
      secrets.example.yaml         → copy to secrets.yaml (credentials)
      dc/                          THE IN-CLUSTER OVERLAY
        irsa-bedrock.sh            creates the one IAM role (Phase 1.2)
        receiver.yaml              ClusterIP receiver, TRIGGER=jira-dc
        ingress-netpol.yaml        allow the Jira namespace → receiver
        config.example.yaml        DC config (assignees = usernames)
docs/customer-install/
  00-COMPLETE-GUIDE.md       ← you are here
  03-configure-jira-data-center.md the DC Jira admin deep-dive
  04b-deploy-data-center-in-cluster.md  the DC deploy deep-dive
  GUIDE-configure-and-change-the-prompt.md  how to change behavior
```
