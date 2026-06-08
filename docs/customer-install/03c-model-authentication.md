# 03c — Model Authentication (per harness)

How each harness authenticates to the LLM it runs on, where the credential
lives, who issues it, and what has to line up for the call to succeed. This is
the companion to [Choose your harness](03b-choose-harness.md): that page picks a
harness, this one explains the **auth** behind each choice so you can install it
securely and debug a `403`/`AccessDenied` quickly.

← [Choose your harness](03b-choose-harness.md) · Next → [Deploy the agent](04-deploy-agent.md)

---

## The one distinction that matters

There are exactly **two** ways a harness gets model credentials in this system,
and the whole security story follows from which one a harness uses:

| | **Keyless (IRSA → Bedrock)** | **Static API key** |
|---|---|---|
| Harnesses | **pi**, **opencode** (Option A) | **kiro-cli**, **opencode** (Option B) |
| What's in the pod | A short-lived, auto-rotated OIDC token mounted by EKS | A long-lived secret string |
| Where it comes from | The `agent-runner` ServiceAccount's IRSA annotation → STS AssumeRoleWithWebIdentity | A Kubernetes `Secret` (`agent-secrets`), injected via `envFrom` |
| Who can invoke what | An IAM policy scoped to **one model ARN** | Whatever the key's account/plan allows |
| Rotation | Automatic (token TTL ~1h, EKS refreshes) | **Manual** — you rotate the key and re-apply the Secret |
| Blast radius if pod is popped | Token expires; scoped to one model; can't leave the cluster (egress fence) | Key is valid until you notice and rotate; full account/plan scope |

**Prefer keyless.** It is the default (pi) and the recommended opencode path.
There is no static model credential to store, leak, or rotate, and a stolen
token is scoped to a single model ARN and expires on its own. Use a static key
only when the harness can't talk to Bedrock (kiro-cli) or when the customer has
a provider account they specifically want to use (opencode Option B).

---

## How keyless (IRSA) auth actually works

This is the path pi always uses and opencode uses by default. No model
credential is ever written to a manifest, a Secret, or the image.

```
 ┌─ Terraform (agent/deploy/terraform/bedrock.tf) ─────────────────────────┐
 │ 1. Creates an IAM role with a policy scoped to ONE Bedrock model ARN    │
 │    (bedrock:InvokeModel + …WithResponseStream — never "*").             │
 │ 2. Trusts the cluster's OIDC provider, FOR a specific                   │
 │    namespace:serviceaccount pair  (var.triage_namespace :               │
 │    var.triage_service_account).                                         │
 └────────────────────────────────┬────────────────────────────────────────┘
                                   │ output: triage_bedrock_role_arn
                                   ▼
 ┌─ ServiceAccount (agent/deploy/k8s/namespace.yaml) ──────────────────────┐
 │   agent-runner, annotated:                                              │
 │     eks.amazonaws.com/role-arn: <triage_bedrock_role_arn>               │
 └────────────────────────────────┬────────────────────────────────────────┘
                                   │ run Job's pod uses serviceAccountName: agent-runner
                                   ▼
 ┌─ The run pod ───────────────────────────────────────────────────────────┐
 │   EKS injects, with NO action by us:                                    │
 │     AWS_ROLE_ARN=<role>                                                  │
 │     AWS_WEB_IDENTITY_TOKEN_FILE=/var/run/secrets/eks.amazonaws.com/...   │
 │   The AWS SDK in pi/opencode does AssumeRoleWithWebIdentity → temp creds │
 │   → bedrock:InvokeModel on the one allowed model.                       │
 └──────────────────────────────────────────────────────────────────────────┘
```

The agent code adds **nothing** for this — `pi.js`'s `buildCommand` returns no
env at all, relying on the inherited process env that EKS populated
(`agent/runtime/harness/pi.js:31`). The egress fence
(`agent/deploy/k8s/netpol.yaml`) then ensures even a compromised run can only
reach Bedrock/Jira/in-cluster GitLab over 443, not an attacker host.

### Three things must agree or IRSA silently fails

This is the #1 source of "it deployed but Bedrock returns AccessDenied":

1. **Namespace + ServiceAccount** — the `namespace_service_accounts` in the IAM
   trust policy (Terraform) must equal the namespace + `serviceAccountName` the
   run Job actually uses. If they differ, EKS never injects a token and the SDK
   falls back to no creds.
2. **Model id** — the model in `RUN_ENV` (`MODEL` for pi,
   `OPENCODE_MODEL` for opencode) must be the **same** model the Terraform
   `bedrock_model_id` scoped the policy to. A different model = `AccessDenied`.
3. **Region** — `AWS_REGION` must be a region the inference profile and your
   Bedrock access cover. opencode needs it set explicitly in `RUN_ENV`; the SDK
   can't resolve the endpoint without it.

---

## Per-harness detail

### pi — keyless, Bedrock only

- **Credential:** none in the pod. IRSA via `agent-runner`.
- **How it's selected:** `pi --provider amazon-bedrock --model <MODEL>`
  (`agent/runtime/harness/pi.js:17`). `MODEL` from `RUN_ENV` becomes `--model`.
- **Model id form:** bare inference-profile id, e.g.
  `us.anthropic.claude-sonnet-4-6` (no provider prefix — the prefix is the
  separate `--provider` flag).
- **Secret needed:** none for the model. (Jira/GitLab secrets still apply.)
- **Failure mode:** wrong `namespace:serviceaccount` in Terraform, or `MODEL`
  ≠ `bedrock_model_id` → `AccessDeniedException` from Bedrock in the Job log.

### kiro-cli — static key, Kiro's own backend

- **Credential:** `KIRO_API_KEY` (format `ksk_…`), a long-lived key from the
  Kiro portal. Stored in `agent-secrets`, injected to the run Job via `envFrom`
  (`agent/deploy/k8s/secrets.example.yaml:73`). kiro-cli reads it from the env;
  the adapter adds nothing (`agent/runtime/harness/kiro-cli.js:42`).
- **Not Bedrock:** this path does **not** use IRSA at all. The model runs on
  Kiro's backend (your Kiro Pro / Pro+ / Power subscription), not your AWS
  account. The IRSA role is inert for this harness.
- **Model selection:** there is **no `--model` flag**. The model comes from your
  Kiro account's default-model / agent config, so `MODEL` is ignored — omit it.
- **Key name must be exact:** `envFrom` maps Secret keys verbatim to env vars, so
  the key MUST be `KIRO_API_KEY` (UPPER_SNAKE_CASE). A dash-cased key is silently
  dropped and the CLI exits 1 (auth failure → Job fails).
- **Governance caveat:** any MCP / model / web-fetch policy your Kiro admin sets
  applies to these headless runs too.

### opencode — your choice of keyless or static key

opencode is the flexible one: it can use **either** auth path, picked entirely by
how you set `OPENCODE_MODEL` and whether you supply a provider key.

**Option A — keyless (Bedrock via IRSA, recommended).** Identical mechanism to
pi: opencode's `amazon-bedrock` provider uses the AWS credential chain, picking
up the IRSA `AWS_WEB_IDENTITY_TOKEN_FILE`/`AWS_ROLE_ARN` from the **same**
`agent-runner` ServiceAccount. No key in the Secret.
- `RUN_ENV`: `HARNESS=opencode,OPENCODE_MODEL=amazon-bedrock/us.anthropic.claude-sonnet-4-6,AWS_REGION=us-west-2,…`
- Model id **must** carry the `amazon-bedrock/` provider prefix and the
  cross-region inference profile your IRSA policy allows; `AWS_REGION` **must**
  be set or the SDK can't resolve the endpoint.

**Option B — static provider key.** e.g. an Anthropic key. Stored in
`agent-secrets` under the env var name your provider expects
(`ANTHROPIC_API_KEY`, etc.), injected via `envFrom`. opencode reads it directly.
- `RUN_ENV`: `HARNESS=opencode,OPENCODE_MODEL=anthropic/claude-sonnet-4-6,…`
- This bypasses IRSA entirely; the model runs on the provider's API, billed to
  that account.

> The adapter passes `--model` only when the configured id contains a `/`
> (`agent/runtime/harness/opencode.js:39`); a bare id falls through to opencode's
> own configured default — so a misconfigured `MODEL` doesn't fail loudly here,
> it silently uses opencode's default. Set `OPENCODE_MODEL` explicitly.

> opencode also has an `auth.json` (from `opencode auth login`) baked-in path,
> but we don't use it for install — credentials come from the IRSA chain or
> `envFrom`, both supplied at runtime, nothing in the image.

---

## What is NOT a model credential (avoid the confusion)

Two other secrets exist in this system; neither authenticates to a model:

- **`WEBHOOK_HMAC_SECRET` / `AUTOMATION_SHARED_SECRET`** — authenticate the
  *inbound webhook* (Jira → receiver), verified constant-time in
  `agent/runtime/lib/auth.js`. They gate who can *trigger* a run, not which
  model the run talks to.
- **`JIRA_API_TOKEN` / `GITLAB_READ_TOKEN`** — the agent's *tool* credentials
  (read code, write the ticket back). The run uses them, the model never sees
  them as auth.

Only `KIRO_API_KEY` and the opencode provider key (e.g. `ANTHROPIC_API_KEY`) are
model credentials, and only on the static-key paths.

---

## Quick decision + verification

```
Do you have Bedrock model access in the cluster's region?
 ├─ Yes, and you want zero stored model creds  → pi  (or opencode Option A)   [keyless]
 ├─ You have a Kiro subscription               → kiro-cli                     [KIRO_API_KEY]
 └─ You have a provider account (e.g. Anthropic) you want to use → opencode B [provider key]
```

Verify the chosen path before launch:

- **Keyless:** in a run pod, `env | grep AWS_` shows `AWS_ROLE_ARN` +
  `AWS_WEB_IDENTITY_TOKEN_FILE`. A test run reaches Bedrock without `AccessDenied`.
- **Static key:** the Secret key name is UPPER_SNAKE_CASE and matches the CLI's
  expected env var; a test run authenticates (exit 0).

---

## Gaps and risks found (read before installing)

Gaps #1–#4 were **fixed** in the repo (described below with what changed); #5–#7
are inherent risks to **confirm in your environment**, not code bugs.

### 1. Terraform IRSA binding did NOT match the K8s manifests — **FIXED**

`agent/deploy/terraform/variables.tf` used to default `triage_namespace =
"triage"` / `triage_service_account = "triage-agent"`, while every K8s manifest
uses namespace **`agents`** and ServiceAccount **`agent-runner`**
(`namespace.yaml`, `job.js`). Applying Terraform with the old defaults bound the
IAM trust policy to `triage:triage-agent`, which never matched
`agents:agent-runner`, so EKS issued no token and **all keyless (pi/opencode-A)
Bedrock calls failed AccessDenied** with no obvious cause.
→ **Fixed:** the variable defaults are now `agents` / `agent-runner` (matching
the manifests), with a warning in the descriptions; `outputs.tf` now points at
`namespace.yaml` / `agent-runner`. Override the vars only if you relocate the SA.

### 2. Default model region mismatch — **FIXED (aligned on EU)**

Terraform defaulted `bedrock_model_id = "eu.anthropic.claude-sonnet-4-6"` while
`receiver.yaml` shipped `us.anthropic.claude-sonnet-4-6` + `AWS_REGION=us-west-2`
— the IAM policy was scoped to the **eu** profile while the call used **us** →
`AccessDenied`. → **Fixed:** everything is aligned on the **EU** inference
profile (`eu.anthropic.claude-sonnet-4-6`, `eu-west-1`) so inference stays
in-region: `receiver.yaml` `RUN_ENV` (`MODEL`/`OPENCODE_MODEL`/`AWS_REGION`),
`example.tfvars`, and the docs, with an explicit "these three MUST match
Terraform's `bedrock_model_id`" note in `receiver.yaml`. To run in another
region, change all four together.

### 3. Hard-coded role ARN and image in committed manifests — **FIXED**

`namespace.yaml` shipped `…:role/workshop-triage-bedrock` and `receiver.yaml`
shipped a `746792595426.dkr.ecr…` lab image — both the dev lab's real values,
easy to apply as-is and then wonder why IRSA points at a foreign account.
→ **Fixed:** both are now unmistakable placeholders
(`arn:aws:iam::<ACCOUNT_ID>:role/<NAME>-triage-bedrock`,
`<ACCT>.dkr.ecr.<REGION>.amazonaws.com/triage-agent:latest`) with a comment
giving the exact `terraform output` to fill them and a warning that leaving them
breaks the pull / binds IRSA to another account.

### 4. opencode model misconfig failed *silently* — **FIXED (now warns)**

If `OPENCODE_MODEL` lacks a `/`, the adapter omits `--model` and opencode uses
**its own default** model rather than erroring — on Bedrock that default may not
be in your IRSA policy (`AccessDenied`), or on a provider key it may bill an
unintended model. The fallback is intentional (a bare Bedrock id like
`eu.anthropic.…` legitimately can't be passed to `--model`), so failing hard
would break the pi-shaped default. → **Fixed:** the adapter now logs a loud
`console.error` to the Job log naming the resolved `OPENCODE_MODEL`/`model` and
telling you to set a `provider/model` id, so a misconfig is visible instead of
mysterious. (`agent/runtime/harness/opencode.js`.)

### 5. Static keys never rotate themselves

`KIRO_API_KEY` / provider keys are long-lived and only rotate when you re-apply
the Secret. There is no expiry, no scoping to one model, and a leaked key is
valid until noticed. The egress fence limits exfil *destinations*, but the key
is still in the pod env (visible to the LLM's shell tool). → For static-key
harnesses, treat key rotation as an operational task
([Operations → rotation](05-operations.md#credential-rotation)) and keep the
egress fence on. Keyless avoids this entirely — prefer it.

### 6. Egress fence is conditional on the CNI (affects all harnesses)

The NetworkPolicy that stops a compromised run from shipping the IRSA token or a
static key off-cluster is **only enforced** when the AWS VPC CNI network-policy
controller is on (`ENABLE_NETWORK_POLICY=true`). If it's off, the model-auth
blast-radius story above is weaker — a stolen key/token could be exfiltrated.
→ **Confirm** the controller is enabled (see
[Security → Egress fence](06-security.md#egress-fence-r12--conditional-on-your-cni)).

### 7. Multi-platform future: IRSA is EKS-specific

The keyless path is built on EKS IRSA (OIDC + `AWS_WEB_IDENTITY_TOKEN_FILE`). On
other platforms the keyless mechanism differs — GKE Workload Identity, AKS
Workload Identity, or self-managed clusters where there is *no* cloud identity
broker (you'd fall back to a static AWS access key, reintroducing a long-lived
credential). → When porting beyond EKS, the adapter contract doesn't change (it
relies on the ambient AWS credential chain), but the **provisioning** layer
(`bedrock.tf`) and the ServiceAccount annotation are EKS-only and need a
per-platform equivalent. Document the keyless mechanism per platform before
claiming "works anywhere."

---

← [Choose your harness](03b-choose-harness.md) · Next → [Deploy the agent](04-deploy-agent.md)
