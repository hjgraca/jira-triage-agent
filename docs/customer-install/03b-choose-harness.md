# 03b — Choose Your Harness (and how it authenticates)

The agent's "brain" is a headless coding-agent CLI that each run Job spawns once
per ticket. It's **pluggable** — the engine is harness-agnostic, so you pick the
one that fits your subscription and model story. **Three are built in**
(pi, kiro-cli, opencode — all proven end-to-end); adding a fourth is a small
adapter file.

**Optional page.** The default (pi on Bedrock via IRSA, no stored key) is the
right choice for most installs. Read on only if you want kiro-cli or opencode, or
want to understand the model-auth before you debug a `403`/`AccessDenied`.

← [Configure Jira](03-configure-jira-data-center.md) · Next → [Deploy the agent](04b-deploy-data-center-in-cluster.md)

---

## Built-in harnesses

| | **pi** (default) | **kiro-cli** | **opencode** |
|---|---|---|---|
| Project | [pi.dev](https://github.com/earendil-works/pi) | [kiro.dev](https://kiro.dev) | [opencode.ai](https://opencode.ai) |
| Model backend | **Bedrock** via IRSA (no key in pod) | Kiro's own backend (**`KIRO_API_KEY`**) | **Bedrock via IRSA** (no key) **or** any provider key |
| Subscription | AWS Bedrock model access | Kiro **Pro / Pro+ / Power** | AWS Bedrock access, or a provider account (e.g. Anthropic) |
| Model selection | `MODEL` env → `--model` | Kiro account default (`MODEL` ignored) | `OPENCODE_MODEL` (or `MODEL` if `provider/model`-shaped) |
| Proven on | KAN-2 (Bedrock) | KAN-6 (Kiro Pro) | KAN-7 (Bedrock/IRSA) |

All three run the **same** skill (same rubric, same `jira.sh`/`gitlab.sh`
scripts, same guardrails). Only the invocation, the credential, and
result-reading differ — that's the whole point of the adapter layer.

## Keyless vs. static key — the one distinction that matters

There are exactly **two** ways a harness gets model credentials, and the security
story follows from which one you use:

| | **Keyless (IRSA → Bedrock)** | **Static API key** |
|---|---|---|
| Harnesses | **pi**, **opencode** (Option A) | **kiro-cli**, **opencode** (Option B) |
| What's in the pod | A short-lived, auto-rotated OIDC token mounted by EKS | A long-lived secret string |
| Source | `agent-runner` SA's IRSA annotation → STS AssumeRoleWithWebIdentity | A K8s `Secret` (`agent-secrets`), via `envFrom` |
| Scope | An IAM policy scoped to **one model ARN** | Whatever the key's account/plan allows |
| Rotation | Automatic (token TTL ~1h) | **Manual** — rotate the key, re-apply the Secret |
| Blast radius if pod is popped | Expires; one model; can't leave the cluster (egress fence) | Valid until you rotate; full account/plan scope |

**Prefer keyless.** It's the default (pi) and the recommended opencode path — no
model credential to store, leak, or rotate. Use a static key only when the
harness can't reach Bedrock (kiro-cli) or the customer has a provider account
they specifically want to use (opencode Option B).

### How keyless (IRSA) works

The `eks-bedrock` overlay's `irsa-bedrock.sh` (a small `aws` CLI script) creates
an IAM role whose policy is scoped to **one** Bedrock model ARN and whose trust is
the cluster's OIDC provider for a specific `namespace:serviceaccount`. Its ARN
goes on the `agent-runner` ServiceAccount annotation (`sa-irsa-patch.yaml`). EKS
then injects `AWS_ROLE_ARN` +
`AWS_WEB_IDENTITY_TOKEN_FILE` into the run pod with no action by us; the AWS SDK
in pi/opencode does `AssumeRoleWithWebIdentity` → `bedrock:InvokeModel` on the
one allowed model. The agent code adds nothing — `pi.js`'s `buildCommand` returns
no env, relying on the inherited process env EKS populated.

**Three things must agree or IRSA silently fails** (the #1 cause of "deployed but
Bedrock returns AccessDenied"):

1. **Namespace + ServiceAccount** — the trust policy's `namespace:serviceaccount`
   must equal what the run Job uses (`agents` / `agent-runner`). Mismatch → EKS
   injects no token, SDK falls back to no creds.
2. **Model id** — the `MODEL`/`OPENCODE_MODEL` in `RUN_ENV` must be the **same**
   model `irsa-bedrock.sh` scoped the policy to (the script's `MODEL=`).
3. **Region** — `AWS_REGION` must cover the inference profile. opencode needs it
   set explicitly in `RUN_ENV` or the SDK can't resolve the endpoint.

## The one thing you set: receiver `RUN_ENV`

The receiver passes `RUN_ENV` (a comma-separated `K=V` list in
`receiver.yaml`) verbatim to every run Job. This is where you select the harness,
the model, and any harness-specific env. Copy the row for your harness:

| Harness | `RUN_ENV` | Secret key | IRSA role |
|---|---|---|---|
| **pi** | `HARNESS=pi,MODEL=eu.anthropic.claude-sonnet-4-6,GITLAB_BASE_URL=…` | none | `agent-runner` |
| **kiro-cli** | `HARNESS=kiro-cli,GITLAB_BASE_URL=…` *(no MODEL)* | `KIRO_API_KEY` | none |
| **opencode** (Bedrock) | `HARNESS=opencode,OPENCODE_MODEL=amazon-bedrock/eu.anthropic.claude-sonnet-4-6,AWS_REGION=eu-west-1,GITLAB_BASE_URL=…` | none | `agent-runner` |
| **opencode** (provider key) | `HARNESS=opencode,OPENCODE_MODEL=anthropic/claude-sonnet-4-6,GITLAB_BASE_URL=…` | `ANTHROPIC_API_KEY` | none |

Things that bite if you skip them:
- **`HARNESS` is the adapter name** (`pi` / `kiro-cli` / `opencode`) — *not* the
  build arg. They differ for kiro: `RUN_ENV` says `HARNESS=kiro-cli`, but the
  build is `make … HARNESS=kiro`.
- **opencode** needs the `amazon-bedrock/` prefix on the model id + `AWS_REGION`;
  the adapter passes `--model` only when the id contains a `/`, otherwise it
  silently uses opencode's own default (set `OPENCODE_MODEL` explicitly, and watch
  the Job log — the adapter logs the resolved model).
- **kiro-cli** has no `--model` flag — the model comes from your Kiro account
  config, so `MODEL` is ignored; omit it.
- Secret keys are **UPPER_SNAKE_CASE** (`KIRO_API_KEY`, `ANTHROPIC_API_KEY`) — the
  Job loads them via `envFrom`, which maps keys verbatim; a dash-cased key is
  silently dropped and the run fails auth.

## Selecting a harness (two places must agree)

1. **Build** — the CLI is baked into the image as a layer: base (engine) →
   `<harness>` (engine + CLI) → `<agent>`. `make agent-image AGENT=jira-triage
   HARNESS=<pi|kiro|opencode>` (or the raw `docker build` sequence in
   [04b → Step 2](04b-deploy-data-center-in-cluster.md)).
2. **Runtime** — `HARNESS` in `receiver.yaml`'s `RUN_ENV` names the **adapter**,
   and must match the CLI baked into the image.

Switching harness means changing **both** `image:`/`AGENT_IMAGE` (to the
image built with that CLI) **and** `RUN_ENV`, then `kubectl apply -f
receiver.yaml` + roll the deployment.

### pi (default) — keyless, Bedrock only
- **Build:** `make agent-image AGENT=jira-triage HARNESS=pi`.
- **Credential:** none in the pod; `agent-runner` IRSA supplies Bedrock.
- `RUN_ENV`: `HARNESS=pi,MODEL=eu.anthropic.claude-sonnet-4-6,GITLAB_BASE_URL=…`.
- **Model id form:** bare inference-profile id (no provider prefix; pi adds
  `--provider amazon-bedrock` itself).

### kiro-cli — static key, Kiro's backend
- **Build:** `make agent-image AGENT=jira-triage HARNESS=kiro`.
- **Key:** add `KIRO_API_KEY: "ksk_…"` (from <https://app.kiro.dev>) to
  `secrets.yaml`. Not Bedrock — the IRSA role is inert for this harness.
- `RUN_ENV`: `HARNESS=kiro-cli,GITLAB_BASE_URL=…` (no `MODEL`).
- **Governance:** any MCP / model / web-fetch policy your Kiro admin sets applies
  to these headless runs too.

### opencode — keyless or static key
- **Build:** `make agent-image AGENT=jira-triage HARNESS=opencode`.
- **Option A — Bedrock via IRSA (recommended, no key):** reuses the same role pi
  uses. Nothing in the Secret.
  `RUN_ENV`: `HARNESS=opencode,OPENCODE_MODEL=amazon-bedrock/eu.anthropic.claude-sonnet-4-6,AWS_REGION=eu-west-1,…`
- **Option B — provider key:** add e.g. `ANTHROPIC_API_KEY` to `secrets.yaml`.
  `RUN_ENV`: `HARNESS=opencode,OPENCODE_MODEL=anthropic/claude-sonnet-4-6,…`
  Bypasses IRSA; billed to the provider account.

> We use `opencode run` (spawn-per-ticket, exits), not `opencode serve`, because
> it matches the one-ephemeral-run-per-webhook model. See the
> [harness README](../../agent/runtime/harness/README.md).

## What is NOT a model credential

Two other secrets exist; neither authenticates to a model:
- **`WEBHOOK_HMAC_SECRET` / `AUTOMATION_SHARED_SECRET`** — authenticate the
  *inbound webhook* (Jira → receiver). They gate who can *trigger* a run.
- **`JIRA_API_TOKEN` / `GITLAB_READ_TOKEN`** — the agent's *tool* credentials
  (read code, write the ticket back). The model never sees them as auth.

Only `KIRO_API_KEY` and the opencode provider key are model credentials, and only
on the static-key paths.

## Quick decision + verification

```
Bedrock model access in the cluster's region?
 ├─ Yes, want zero stored model creds  → pi  (or opencode Option A)   [keyless]
 ├─ Have a Kiro subscription           → kiro-cli                     [KIRO_API_KEY]
 └─ Have a provider account to use     → opencode Option B            [provider key]
```

Verify before launch:
- **Keyless:** in a run pod, `env | grep AWS_` shows `AWS_ROLE_ARN` +
  `AWS_WEB_IDENTITY_TOKEN_FILE`; a test run reaches Bedrock without `AccessDenied`.
- **Static key:** the Secret key name is UPPER_SNAKE_CASE and matches the CLI's
  expected env var; a test run authenticates (exit 0).

## Risks to confirm in your environment

- **Static keys never self-rotate.** `KIRO_API_KEY` / provider keys are
  long-lived and only change when you re-apply the Secret. Treat rotation as an
  operational task ([Operations → rotation](05-operations.md#credential-rotation))
  and keep the egress fence on. Keyless avoids this entirely — prefer it.
- **The egress fence is conditional on the CNI.** The NetworkPolicy that stops a
  compromised run from shipping a token/key off-cluster is only enforced when the
  AWS VPC CNI network-policy controller is on. Confirm it
  ([Security → egress fence](06-security.md#egress-fence-r12--conditional-on-your-cni)).
- **Keyless is EKS-specific.** It's built on EKS IRSA. Porting beyond EKS (GKE/AKS
  Workload Identity, or self-managed) needs a per-platform provisioning
  equivalent; the adapter contract (ambient AWS credential chain) is unchanged.

## Bring your own harness

The engine selects adapters from `agent/runtime/harness/`. To support a different
CLI: drop in one adapter file (`buildCommand` + optional `interpret`/`finalize`),
register it in `index.js`, add a `deploy/docker/<harness>.Dockerfile` that
installs the CLI, then set `image`/`AGENT_IMAGE` + `HARNESS=<adapter>` in
`RUN_ENV`. Full guide:
**[agent/runtime/harness/README.md](../../agent/runtime/harness/README.md)**.

> **Dockerfile gotcha** (hit by both kiro and opencode): the base sets
> `HOME=/home/agent` and the CLI installer runs as root, so the binary lands in
> `/home/agent/.local/bin` and leaves `~/.local` root-owned. Your Dockerfile must
> `find` the binary there and `chown -R 10001:10001 /home/agent` — see
> `kiro.Dockerfile` / `opencode.Dockerfile`.

Next → [Deploy the agent](04b-deploy-data-center-in-cluster.md)
