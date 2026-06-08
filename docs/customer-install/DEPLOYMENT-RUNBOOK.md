# Deployment Runbook — Jira Triage Agent (Jira DC, in-cluster)

A sequenced, start-to-finish plan to get the triage agent running and tested
**end to end** in the customer's infrastructure. Each step says **who** does it, **what**
to run, and the **exit check** that proves the step is done before you move on.

This runbook is for the **Data Center, in-cluster** topology specifically:

```
Corporate net ─VPN─ Transit Gateway ─ VPC (EKS "devtools")
                                          ├─ Jira DC 10.x  (namespace: <jira-ns>)
                                          │     └── POST ──┐  in-cluster, cross-namespace, no internet
                                          ├─ agents ns ◄───┘  http://agent-receiver.agents.svc.cluster.local/jira-webhook
                                          │     └─ receiver → run Job → Bedrock (eu-west-1, IRSA)
                                          └─ NAT ─→ GitLab (external, HTTPS)
```

Reference docs (read alongside): [04b — Deploy DC in-cluster](04b-deploy-data-center-in-cluster.md),
[03 — Configure Jira](03-configure-jira.md), [05 — Operations](05-operations.md),
[06 — Security](06-security.md).

> **Legend** — Owner: **HG** = you (deploying engineer) · **CUST** = customer admin
> (Jira/GitLab/AWS). Many steps are CUST-gated; do those asks early so they don't
> block you.

---

## Phase 0 — Gather inputs and confirm the code (before touching the cluster)

Nothing here changes the customer's infra. It removes every unknown so the live
steps don't stall.

### Step 0.1 — Collect the values (CUST → HG)

Ask the customer for these and record them in a scratch file. **This is the gating
step** — every later placeholder comes from here.

| # | Value | Where it's used | Asked of |
|---|---|---|---|
| 1 | EKS **cluster name** + **region** (expect `eu-west-1`) | `irsa-bedrock.sh`, kubeconfig | CUST |
| 2 | Cluster **OIDC provider ARN** (only for the raw-`aws` fallback; `eksctl` derives it) | `irsa-bedrock.sh` fallback | CUST/HG |
| 3 | **Jira namespace** name (where Jira DC pods run) | `dc/ingress-netpol.yaml` | CUST |
| 4 | Does the **VPC CNI network-policy controller** enforce policy? (`ENABLE_NETWORK_POLICY=true`) | netpol behavior | CUST |
| 5 | Jira **base URL** for write-back (in-cluster DNS or corporate ALB host) | `JIRA_BASE_URL` | CUST |
| 6 | Jira DC **version** (confirm 10.x) + are **PATs** enabled? | auth scheme | CUST |
| 7 | **GitLab** base URL (external, via NAT) | `GITLAB_BASE_URL` | CUST |
| 8 | **DC usernames** allowed to trigger (and the on-call pool, if any) | `AUTHORIZED_ACTORS`, config `assignees` | CUST |
| 9 | A throwaway **test project key** (e.g. `OPS`) for the dry run | webhook JQL, e2e | CUST |
| 10 | EU-only **data-residency** constraint? (the `eu.` profile spans EU regions) | model choice | CUST |

**Exit check:** all 10 filled. If #4 is "no/unsure", note it — the ingress policy
will be inert and you fall back to HMAC-only auth (still safe, just no network
fence). If #6 says PATs are disabled, you'll set `JIRA_AUTH_SCHEME=basic`.

### Step 0.2 — Confirm tooling on the deploy machine (HG)

```bash
kubectl version --client && aws --version && eksctl version && docker buildx version && jq --version
```

**Exit check:** `kubectl`, `aws v2`, `eksctl`, `docker buildx`, `jq` all present.
(No Terraform — the one IAM role is created by `dc/irsa-bedrock.sh`. If `eksctl`
isn't available, the script prints a raw-`aws iam` fallback instead.)

### Step 0.3 — Run the DC test suites locally (HG)

Prove the DC variant is green before shipping it.

```bash
cd <repo>
( cd agent/runtime && node --test )                       # expect 54 pass / 0 fail
bash agent/agents/jira-triage-dc/tests/run.sh             # expect PASS=20 FAIL=0
```

**Exit check:** both suites pass. (These run with no cluster — pure logic + script
shape tests.)

---

## Phase 1 — AWS foundation (Bedrock + IRSA)

### Step 1.1 — Enable Bedrock model access (CUST, AWS console)

In the EKS account, **eu-west-1**: Bedrock → Model access → request/confirm access
to **Claude Sonnet 4.x** (the `eu.anthropic.claude-sonnet-4-6` inference profile).

**Exit check:**
```bash
aws bedrock list-foundation-models --region eu-west-1 \
  --query "modelSummaries[?contains(modelId,'claude-sonnet-4')].modelId" --output text
```
returns the model, and Model access shows **Access granted**.

### Step 1.2 — Create the Bedrock IRSA role (HG) — one script, no Terraform

The agent's only cloud resource is one IAM role (policy scoped to the model, trust
on the cluster OIDC for `agents:agent-runner`). The bundled script creates it; it
also associates the cluster OIDC provider if it's missing.

```bash
CLUSTER=<cluster> REGION=eu-west-1 \
  agent/deploy/k8s/dc/irsa-bedrock.sh
# prints:  eks.amazonaws.com/role-arn: arn:aws:iam::<acct>:role/<cluster>-triage-bedrock
```

**Exit check:** the script prints a **role ARN** — record it for Step 4.2
(`namespace.yaml`). The IAM policy is scoped to `eu.anthropic.claude-sonnet-4-6`,
not `*`. (No `eksctl`? The script prints a raw-`aws iam` fallback that needs the
OIDC provider ARN, value #2.)

---

## Phase 2 — Build and push the DC image

### Step 2.1 — Create the ECR repo (HG/CUST)

```bash
aws ecr create-repository --repository-name triage-agent --region eu-west-1 2>/dev/null || true
```

### Step 2.2 — Build + push the DC agent image (HG) — raw docker, no `make`

Three layers, build context `agent/`, pinned `linux/amd64`:

```bash
ACCT=$(aws sts get-caller-identity --query Account --output text)
REPO=$ACCT.dkr.ecr.eu-west-1.amazonaws.com/triage-agent
aws ecr get-login-password --region eu-west-1 | docker login --username AWS --password-stdin "${REPO%/*}"
docker buildx build --platform linux/amd64 -f agent/deploy/docker/base.Dockerfile -t agent-base:local --load agent
docker buildx build --platform linux/amd64 -f agent/deploy/docker/pi.Dockerfile --build-arg BASE=agent-base:local -t agent-pi:local --load agent
docker buildx build --platform linux/amd64 -f agent/agents/jira-triage-dc/Dockerfile --build-arg BASE=agent-pi:local -t "$REPO:jira-triage-dc-pi" --push agent
# → <acct>.dkr.ecr.eu-west-1.amazonaws.com/triage-agent:jira-triage-dc-pi
```

**Exit check:**
```bash
aws ecr describe-images --repository-name triage-agent --region eu-west-1 \
  --query "imageDetails[?contains(imageTags,'jira-triage-dc-pi')].imageTags" --output text
```
shows the tag. Image is `linux/amd64` (the Makefile pins it — must match node arch).

---

## Phase 3 — Configure GitLab and Jira (mostly CUST)

Do these in parallel with Phase 1–2; they gate Phase 5.

### Step 3.1 — GitLab read token + reachability (CUST → HG)

- Create a **project/group deploy token**, scopes `read_repository` (+ `read_api`
  for routing). → this is `GITLAB_READ_TOKEN`.
- Confirm the cluster can reach GitLab over NAT (run after Phase 4 namespace exists):
  ```bash
  kubectl -n agents run gl-probe --rm -it --restart=Never --image=curlimages/curl -- \
    curl -sS -o /dev/null -w '%{http_code}\n' \
    -H "PRIVATE-TOKEN: <token>" "https://<gitlab-host>/api/v4/projects?per_page=1"   # expect 200
  ```

**Exit check:** token created; probe returns `200` (defer the probe to after Step 4.1 if needed).

### Step 3.2 — Jira DC bot + PAT + allowed-value sets (CUST → HG)

- Create a **dedicated bot user** (e.g. `triage-bot`). Grant it: browse, add
  comments, edit issues, transition (if you'll enable transitions) on the test project.
- Generate a **Personal Access Token** (Profile → Personal Access Tokens). → `JIRA_API_TOKEN`.
  If PATs are disabled (value #6), use the bot password + plan to set `JIRA_AUTH_SCHEME=basic`.
- Read the real value sets off a live ticket (use these to fill `config.yaml`):
  ```bash
  BASE=<jira-base>; TOKEN=<bot-pat>
  curl -sS "$BASE/rest/api/2/issue/<KEY>?fields=priority,issuetype,labels" \
    -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json' \
    | jq '{priority:.fields.priority.name, issuetype:.fields.issuetype.name}'
  curl -sS "$BASE/rest/api/2/issue/<KEY>/transitions" \
    -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json' | jq '.transitions[] | {id,name}'
  ```
- Confirm the bot identity (note `name`/`key` — DC has no accountId):
  ```bash
  curl -sS "$BASE/rest/api/2/myself" -H "Authorization: Bearer $TOKEN" | jq '{name,key,displayName}'
  ```

**Exit check:** bot PAT works against `/rest/api/2/myself`; you have the real
priority names, issue types, transition IDs, and the trigger **usernames**.

### Step 3.3 — Generate the webhook HMAC secret (HG)

```bash
openssl rand -hex 32     # → WEBHOOK_HMAC_SECRET; reuse the SAME value in the Jira webhook (Step 6)
```

---

## Phase 4 — Fill manifests and apply to the cluster

### Step 4.1 — Point kubectl at the cluster (HG)

```bash
aws eks update-kubeconfig --region eu-west-1 --name <cluster>
kubectl get ns   # sanity: you see agents (after first apply) and the Jira ns
```

### Step 4.2 — Fill the DC overlay + shared manifests (HG)

```bash
cp agent/deploy/k8s/dc/config.example.yaml agent/deploy/k8s/config.yaml
cp agent/deploy/k8s/secrets.example.yaml   agent/deploy/k8s/secrets.yaml
```

Edit, using the recorded values:

- **`agent/deploy/k8s/secrets.yaml`**: `JIRA_API_TOKEN`=bot PAT,
  `JIRA_EMAIL`=bot username (used only if Basic), `GITLAB_READ_TOKEN`=deploy token,
  `WEBHOOK_HMAC_SECRET`=Step 3.3 value. Leave `AUTOMATION_SHARED_SECRET`/`KIRO_*`/
  `ANTHROPIC_*` as placeholders.
- **`agent/deploy/k8s/config.yaml`**: real priorities, issuetypes, transitions,
  labels; `assignees`=on-call **usernames** (or `[]` to recommend-only).
- **`agent/deploy/k8s/namespace.yaml`**: `agent-runner` SA annotation
  `eks.amazonaws.com/role-arn` = the role ARN printed by `irsa-bedrock.sh` (Step 1.2).
- **`agent/deploy/k8s/dc/receiver.yaml`**: `image` + `AGENT_IMAGE` = your pushed
  tag; `RUN_ENV` `GITLAB_BASE_URL=https://<gitlab-host>`; `AUTHORIZED_ACTORS` =
  trigger **usernames**. (`TRIGGER=jira-dc`, ClusterIP already set.) If PATs are
  off, append `JIRA_AUTH_SCHEME=basic` to `RUN_ENV`.
- **`agent/deploy/k8s/dc/ingress-netpol.yaml`**: replace `<jira-namespace>` (value #3).
  If the Jira ns lacks the `kubernetes.io/metadata.name` label, label it (the file
  header shows the command).

**Exit check (offline validation):**
```bash
for f in agent/deploy/k8s/dc/*.yaml agent/deploy/k8s/config.yaml; do
  kubectl apply --dry-run=client -f "$f" >/dev/null && echo "ok $f"; done
grep -R "REPLACE_ME\|<ACCT>\|<jira-namespace>\|<your-gitlab-host>\|<dc-username" \
  agent/deploy/k8s/config.yaml agent/deploy/k8s/secrets.yaml agent/deploy/k8s/dc/receiver.yaml \
  agent/deploy/k8s/dc/ingress-netpol.yaml agent/deploy/k8s/namespace.yaml || echo "no placeholders left ✅"
```

### Step 4.3 — Apply, in order (HG)

```bash
kubectl apply -f agent/deploy/k8s/namespace.yaml
kubectl apply -f agent/deploy/k8s/rbac.yaml
kubectl apply -f agent/deploy/k8s/resourcequota.yaml
kubectl apply -f agent/deploy/k8s/netpol.yaml                # run-pod egress fence (shared)
kubectl apply -f agent/deploy/k8s/dc/ingress-netpol.yaml     # receiver ingress: allow Jira ns
kubectl apply -f agent/deploy/k8s/config.yaml
kubectl apply -f agent/deploy/k8s/secrets.yaml
kubectl apply -f agent/deploy/k8s/dc/receiver.yaml           # DC receiver (ClusterIP, TRIGGER=jira-dc)
kubectl -n agents rollout status deploy/agent-receiver
```

**Exit check:** `deploy/agent-receiver` READY 2/2; receiver logs a `listening`
line with `trigger:"jira-dc"`:
```bash
kubectl -n agents logs -l app.kubernetes.io/name=agent-receiver --tail=5
```

---

## Phase 5 — Wire the trigger and verify the receiver-inward chain

### Step 5.1 — In-cluster reachability (HG/CUST)

From inside the **Jira namespace** (proves the ingress policy + DNS):
```bash
kubectl -n <jira-ns> run probe --rm -it --restart=Never --image=curlimages/curl -- \
  curl -s -o /dev/null -w '%{http_code}\n' \
  http://agent-receiver.agents.svc.cluster.local/healthz       # expect 200
```

**Exit check:** `200`. If it hangs → the ingress NetworkPolicy namespace selector
is wrong, or the CNI isn't enforcing (value #4). Fix before continuing.

### Step 5.2 — Synthetic signed webhook (HG) — receiver → Job, no Jira yet

Confirms auth + Job creation independent of Jira. Run from a pod that can reach
the Service (or `kubectl port-forward`):

```bash
SECRET=<WEBHOOK_HMAC_SECRET>
BODY='{"webhookEvent":"jira:issue_created","user":{"name":"<allowed-username>"},"issue":{"key":"OPS-1"}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')"
# from a probe pod in-cluster:
curl -sS -XPOST http://agent-receiver.agents.svc.cluster.local/jira-webhook \
  -H "Content-Type: application/json" -H "X-Hub-Signature: $SIG" --data "$BODY"
kubectl -n agents get jobs
kubectl -n agents logs -l app.kubernetes.io/name=agent-receiver --tail=10 | grep '"msg":"spawn"'
```

**Exit checks:**
- A Job appears and the receiver logs `"msg":"spawn"`.
- **Dedupe:** re-send the same body → second create is `"msg":"duplicate"`, no 2nd Job.
- **Auth:** send with a bad signature → `401` + `reject reason:"unauthenticated"`.

> This run Job will likely fail at the Jira write (issue `OPS-1` may not exist) —
> that's fine here; we're testing the receiver→Job plumbing, not the triage. The
> real triage is Step 6.

### Step 5.3 — Register the Jira system webhook (CUST)

Jira admin → **System → WebHooks → Create**:
- **URL:** `http://agent-receiver.agents.svc.cluster.local/jira-webhook`
- **Secret:** the `WEBHOOK_HMAC_SECRET` (same as Step 3.3 / 4.2).
- **Events:** `Issue: created`, `Issue: updated`.
- **JQL:** scope to the test project, e.g. `project = OPS`.

**Exit check:** webhook saved and enabled. (If Jira egress is itself
NetworkPolicy-fenced, CUST allows it to reach the `agents` ns on TCP 8080.)

### Step 5.4 — Capture a REAL signature + confirm v2 shapes (HG/CUST) — BLOCKING

These two can only be checked against the live instance:

- **Signature prefix:** trigger one real webhook, inspect the receiver log. If it
  `reject`s a known-good delivery, the `X-Hub-Signature` algo/prefix differs from
  `runtime/lib/auth.js` (`sha256=`). DC 10.x uses sha256; confirm.
- **API shapes:** with the bot PAT, manually exercise the DC `jira.sh` verbs
  against a throwaway issue (comment, set-fields, assign) and confirm 2xx:
  ```bash
  kubectl -n agents run shape --rm -it --restart=Never \
    --image=<acct>.dkr.ecr.eu-west-1.amazonaws.com/triage-agent:jira-triage-dc-pi \
    --env JIRA_BASE_URL=<base> --env JIRA_API_TOKEN=<pat> --env TRIAGE_CONFIG=/agents/jira-triage-dc/tests/config.test.json \
    --command -- /agents/jira-triage-dc/scripts/jira.sh comment OPS-1 "shape probe"
  ```

**Exit check:** real signed delivery is accepted (not 401); comment posts as
plain/wiki text; assignee accepts `{name}`. Fix the DC `jira.sh` if any shape differs.

---

## Phase 6 — End-to-end test in the customer infra

### Step 6.1 — Triage a real low/medium ticket (HG/CUST)

On the test project, an **allowlisted user** adds the `triage` label to a
low/medium ticket.

**Watch:**
```bash
kubectl -n agents logs -l app.kubernetes.io/name=agent-receiver -f \
  | grep -E '"msg":"(spawn|drop|reject)"'                       # expect spawn, authVia hmac
kubectl -n agents get jobs --sort-by=.metadata.creationTimestamp | tail -3
kubectl -n agents logs -l app.kubernetes.io/name=agent-run --tail=80 --prefix
```

**Exit checks (ground truth is in Jira):**
- The ticket gets a comment starting `> *This was generated by AI during triage.*`
- Fields set only within the allowed sets; `triage` label **removed**.
- The Job shows COMPLETIONS `1/1`.

### Step 6.2 — High-severity gate (HG/CUST)

Label a clearly high-severity ticket (data loss / security / outage wording).

**Exit check:** the agent adds `needs-human` + a recommendation comment and makes
**no** field writes (R2c severity gate).

### Step 6.3 — Negative paths (HG)

- A **non-allowlisted** user adds the label → receiver logs
  `drop reason:"unauthorized label actor"`, no Job.
- An unrelated field edit (no label-add) → `drop reason:"ineligible event"`.

**Exit check:** both behave as above.

---

## Phase 7 — Operational backstops before "go live"

- [ ] **AWS Budget / Bedrock quota** set as the cumulative dollar ceiling (no
      in-app daily counter — see [06-security](06-security.md)).
- [ ] **`pods` quota** in `resourcequota.yaml` tuned (`= receiver replicas + max
      concurrent runs`).
- [ ] **NetworkPolicy enforcement** confirmed (value #4) — else egress fence +
      ingress lock are inert; document the accepted risk.
- [ ] **Credential rotation** owner + schedule agreed (≤90 days; rotate PAT,
      GitLab token, HMAC secret — [05-operations](05-operations.md#credential-rotation)).
- [ ] **Pause switch** known: disable the webhook (soft) or
      `kubectl -n agents scale deploy/agent-receiver --replicas=0` (hard).
- [ ] **Widen the webhook JQL** from the test project to the real scope only after
      6.1–6.3 pass.

---

## Rollback

| To undo | Command |
|---|---|
| Stop all new runs immediately | `kubectl -n agents scale deploy/agent-receiver --replicas=0` |
| Stop deliveries at the source | Disable/delete the Jira system webhook |
| Remove the agent entirely | `kubectl delete ns agents` (deletes receiver, Jobs, config, secrets) |
| Remove AWS IRSA role | `eksctl delete iamserviceaccount --cluster <cluster> --namespace agents --name agent-runner` (then delete the policy if unused) |

The agent only ever **reads** GitLab and writes to the **one** test project's
tickets within allowed-value sets — rollback has no data-loss surface beyond
comments/labels on test tickets.

---

## Critical path (what blocks what)

```
0.1 inputs ─┬─ 1.1 Bedrock access ─────┐
            ├─ 1.2 irsa-bedrock.sh (IRSA role) ─┐
            ├─ 3.1 GitLab token                 ├─ 4.2 fill ─ 4.3 apply ─ 5.1 reach ─ 5.2 synthetic ─ 5.4 capture sig/shapes ─ 6.x e2e ─ 7 backstops
            └─ 3.2 Jira bot/PAT ─ 3.3 HMAC ─────┘                                    ─ 5.3 webhook ──┘
2.1/2.2 image ────────────────────────────────────────────────┘
```

The two hard, customer-gated blockers are **1.1 (Bedrock access)** and **3.2 (Jira
bot + PAT)** — request both at the very start. The two checks that can only pass
against the live instance are **5.1 (in-cluster reachability)** and **5.4 (real
signature + v2 shapes)** — budget time for one fix iteration on each.
