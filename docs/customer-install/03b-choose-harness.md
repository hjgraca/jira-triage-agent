# 03b — Choose Your Harness

The agent's "brain" is a headless coding-agent CLI that each run Job spawns once
per ticket. It's **pluggable** — the engine is harness-agnostic, so you pick the
one that fits your subscription and model story. **Three are built in**
(pi, kiro-cli, opencode — all three proven end-to-end); adding a fourth is a
small adapter file.

← [Configure Jira](03-configure-jira.md) · Next → [Deploy the agent](04-deploy-agent.md)

---

## Built-in harnesses

| | **pi** (default) | **kiro-cli** | **opencode** |
|---|---|---|---|
| Project | [pi.dev](https://github.com/earendil-works/pi) | [kiro.dev](https://kiro.dev) | [opencode.ai](https://opencode.ai) |
| Invocation | `pi --mode json` | `kiro-cli chat --no-interactive` | `opencode run --format json` |
| Model backend | **Amazon Bedrock** via IRSA (no key in pod) | Kiro's own backend (**`KIRO_API_KEY`**) | **Bedrock via IRSA** (no key) **or** any provider key |
| Subscription | AWS Bedrock model access | Kiro **Pro / Pro+ / Power** | AWS Bedrock access, or a provider account (e.g. Anthropic) |
| Skill loading | native `--skill <path>` | rubric **inlined** | rubric **inlined** |
| Output | streaming JSON | final response; result from **exit code** | streaming JSON + exit code |
| Model selection | `MODEL` env | Kiro default-model/agent config (`MODEL` ignored) | `OPENCODE_MODEL` (or `MODEL` if it's `provider/model`-shaped) |
| Permissions | n/a (skill scripts) | `--trust-tools=read,execute_bash` | `--dangerously-skip-permissions` (scripts are the guardrail) |
| Proven on | KAN-2 (Bedrock) | KAN-6 (Kiro Pro) | KAN-7 (Bedrock/IRSA) |

All three run the **same** `jira-triage` skill (same rubric, same
`jira.sh`/`gitlab.sh` scripts, same guardrails). Only the invocation, the
credential, and result-reading differ — that's the whole point of the adapter
layer.

### Receiver `RUN_ENV` per harness (the one thing you set)

The receiver passes `RUN_ENV` (a comma-separated `K=V` list in
`agent/deploy/k8s/receiver.yaml`) verbatim to every run Job. **This is where you
select the harness, the model, and any harness-specific env.** Copy the row for
your harness:

| Harness | `RUN_ENV` | Secret key needed | IRSA role used |
|---|---|---|---|
| **pi** | `HARNESS=pi,MODEL=eu.anthropic.claude-sonnet-4-6,GITLAB_BASE_URL=…` | none | `agent-runner` (Bedrock) |
| **kiro-cli** | `HARNESS=kiro-cli,GITLAB_BASE_URL=…` *(no MODEL — Kiro account picks it)* | `KIRO_API_KEY` | none |
| **opencode** (Bedrock) | `HARNESS=opencode,OPENCODE_MODEL=amazon-bedrock/eu.anthropic.claude-sonnet-4-6,AWS_REGION=eu-west-1,GITLAB_BASE_URL=…` | none | `agent-runner` (Bedrock) |
| **opencode** (provider key) | `HARNESS=opencode,OPENCODE_MODEL=anthropic/claude-sonnet-4-6,GITLAB_BASE_URL=…` | `ANTHROPIC_API_KEY` | none |

Notes that bite if you skip them:
- **`HARNESS` is the adapter name** (`pi` / `kiro-cli` / `opencode`) — *not* the
  Dockerfile/build arg (`pi` / `kiro` / `opencode`). They differ for kiro
  (`HARNESS=kiro-cli`, but `make … HARNESS=kiro`).
- **`MODEL` is the env the engine reads** (not `TRIAGE_MODEL`). pi passes it as
  `--model`; opencode reads `OPENCODE_MODEL` first, then `MODEL` only if it
  already has a `provider/` prefix; kiro ignores both.
- **opencode on Bedrock needs `AWS_REGION`** in `RUN_ENV`, and the model id must
  carry the `amazon-bedrock/` prefix + the `eu.` inference profile your IRSA
  policy allows.
- Secret keys are **UPPER_SNAKE_CASE** (`KIRO_API_KEY`, `ANTHROPIC_API_KEY`) — the
  Job loads the secret via `envFrom`, which maps keys verbatim to env vars; a
  dash-cased key is silently dropped (see [Deploy → Step 3](04-deploy-agent.md)).
- For the **IRSA (Bedrock) harnesses**, `agent/deploy/terraform`'s
  `bedrock_model_id` must match the model in `RUN_ENV`, or the scoped IAM policy
  denies the call.

> **opencode `run` vs `serve`.** opencode also has a long-lived HTTP server
> (`opencode serve`). We use **`opencode run`** (spawn-per-ticket, exits) because
> it matches the one-ephemeral-run-per-webhook security model; a persistent
> server would be a different integration shape. If you want warm starts,
> `opencode run --attach http://host:port` can front a `serve` daemon without
> changing the adapter. See [harness README](../../agent/runtime/harness/README.md#boundary-this-contract-is-subprocess-shaped).

## How to select

The harness is selected in **two places that must agree**:

1. **Build** — the CLI is baked into the image as a layer:
   base (engine) → `<harness>` (engine + CLI) → `<agent>` (the one agent).
   `make agent-image AGENT=jira-triage HARNESS=<pi|kiro|opencode>`.
2. **Runtime** — `HARNESS` in `receiver.yaml`'s `RUN_ENV` names the **adapter**
   the run Job uses (and must match the CLI baked into the image):

   ```yaml
   - name: RUN_ENV
     value: "HARNESS=pi,MODEL=eu.anthropic.claude-sonnet-4-6,GITLAB_BASE_URL=…"
   ```

When you switch harness you change **both** the `image:`/`AGENT_IMAGE` (to the
image built with that CLI) **and** `RUN_ENV` (per the table above), then
`kubectl apply -f receiver.yaml` and roll the deployment.

> **Build arg vs adapter name.** `make … HARNESS=kiro` builds `kiro.Dockerfile`,
> but the runtime adapter is `kiro-cli` → `RUN_ENV` must say `HARNESS=kiro-cli`.
> pi and opencode use the same word for both.

### Using pi (default)

- **Image:** `make agent-image AGENT=jira-triage HARNESS=pi`.
- **Credential:** none in the pod — the `agent-runner` IRSA ServiceAccount
  supplies Bedrock access. Make sure `agent/deploy/terraform`'s `bedrock_model_id`
  matches the `MODEL` in `RUN_ENV`.
- `RUN_ENV`: `HARNESS=pi,MODEL=eu.anthropic.claude-sonnet-4-6,GITLAB_BASE_URL=…`.

### Using kiro-cli

1. **Build the image with kiro:**
   ```bash
   make agent-image AGENT=jira-triage HARNESS=kiro
   # or, raw: base (engine) → kiro (engine + CLI) → agent (one agent)
   docker build -f agent/deploy/docker/base.Dockerfile    -t agent-base:local       agent
   docker build -f agent/deploy/docker/kiro.Dockerfile    --build-arg BASE=agent-base:local -t agent-kiro:local agent
   docker build -f agent/agents/jira-triage/Dockerfile    --build-arg BASE=agent-kiro:local -t "$REPO:latest"  agent
   ```
2. **Add the API key** to `agent/deploy/k8s/secrets.yaml`:
   ```yaml
   KIRO_API_KEY: "ksk_xxxxxxxx"   # from https://app.kiro.dev
   ```
   The run Job loads the whole secret via `envFrom`, so this key reaches
   `kiro-cli` as `$KIRO_API_KEY` directly (pi ignores it). The key **must** be
   `KIRO_API_KEY` — a dash-cased key would be dropped by the shell.
3. **Set the harness:** `HARNESS: "kiro-cli"` in receiver.yaml.
4. Apply secret + receiver and roll the deployment.

> **Model on kiro:** `kiro-cli chat` has no `--model` flag — the model comes from
> your Kiro default-model / agent configuration, so the `MODEL` env is ignored
> for this harness (omit it from `RUN_ENV`). Configure the default model in your
> Kiro account.

> **Governance:** any MCP / model / web-fetch policies your Kiro administrator
> sets apply to headless sessions too. If your pipeline depends on MCP servers,
> the adapter can be extended to pass `--require-mcp-startup` (fail fast).

### Using opencode

1. **Build the image with opencode:**
   ```bash
   make agent-image AGENT=jira-triage HARNESS=opencode
   # or, raw: base → opencode → agent
   docker build -f agent/deploy/docker/base.Dockerfile     -t agent-base:local         agent
   docker build -f agent/deploy/docker/opencode.Dockerfile --build-arg BASE=agent-base:local -t agent-opencode:local agent
   docker build -f agent/agents/jira-triage/Dockerfile     --build-arg BASE=agent-opencode:local -t "$REPO:latest" agent
   ```
2. **Pick an auth path.** opencode supports **Amazon Bedrock via IRSA** (no key —
   reuses the same role pi uses) *or* a provider API key.

   **Option A — Bedrock via IRSA (recommended; no key):** opencode's
   `amazon-bedrock` provider uses the AWS credential chain, including the
   `AWS_WEB_IDENTITY_TOKEN_FILE`/`AWS_ROLE_ARN` that EKS injects from the
   `agent-runner` ServiceAccount's IRSA annotation — the **same** Bedrock role as
   pi. Nothing to add to the secret. In `RUN_ENV` set:
   ```
   HARNESS=opencode,OPENCODE_MODEL=amazon-bedrock/eu.anthropic.claude-sonnet-4-6,AWS_REGION=eu-west-1
   ```
   The model id needs the `amazon-bedrock/` provider prefix and the `eu.`
   cross-region inference profile your IRSA policy is scoped to; `AWS_REGION`
   must be set or the SDK can't resolve the endpoint. (`opencode models | grep
   bedrock` lists the available ids.)

   **Option B — provider API key:** add it to `agent/deploy/k8s/secrets.yaml`,
   named for the env var your provider expects (opencode reads it directly from
   env via `envFrom`):
   ```yaml
   ANTHROPIC_API_KEY: "<your provider API key>"   # e.g. an Anthropic key
   ```
   Then set `HARNESS=opencode,OPENCODE_MODEL=anthropic/claude-sonnet-4-6`.
3. Apply secret (if any) + receiver and roll the deployment.

> **Model on opencode:** `opencode run` needs `--model provider/model` (e.g.
> `amazon-bedrock/eu.anthropic.claude-sonnet-4-6` or
> `anthropic/claude-sonnet-4-6`). The adapter passes it only when the configured
> model contains a `/`; otherwise it falls through to opencode's configured
> default. We use `opencode run`, not `opencode serve` — see the table note above.

## Bring your own harness

The engine selects adapters from `agent/runtime/harness/`. To support a different
CLI: drop in one adapter file (`buildCommand` + optional `interpret` +
`finalize`), register it in `index.js`, add a `deploy/docker/<harness>.Dockerfile`
that installs the CLI, then set `image`/`AGENT_IMAGE` to the built image and
`HARNESS=<adapter>` in `RUN_ENV`. Full guide:
**[agent/runtime/harness/README.md](../../agent/runtime/harness/README.md)**.

> **Dockerfile gotcha** (hit by both kiro and opencode): the base image sets
> `HOME=/home/agent` and the CLI installer runs as root, so the binary lands in
> `/home/agent/.local/bin` (not `/root`) and leaves `~/.local` root-owned. Your
> Dockerfile must `find` the binary there and `chown -R 10001:10001 /home/agent`
> so the non-root runtime user can write the CLI's state — see `kiro.Dockerfile`
> / `opencode.Dockerfile`.

Next → [Deploy the agent](04-deploy-agent.md)
