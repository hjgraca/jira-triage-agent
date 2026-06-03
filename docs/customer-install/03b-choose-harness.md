# 03b — Choose Your Harness

The agent's "brain" is a headless coding-agent CLI that the listener spawns once
per ticket. It's **pluggable** — the listener is harness-agnostic, so you pick the
one that fits your subscription and model story. Two are built in; adding a third
is a small adapter file.

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
| Model selection | `TRIAGE_MODEL` | Kiro default-model/agent config (`TRIAGE_MODEL` ignored) | `OPENCODE_MODEL` or `TRIAGE_MODEL` if `provider/model`-shaped |
| Permissions | n/a (skill scripts) | `--trust-tools=read,execute_bash` | `--dangerously-skip-permissions` (scripts are the guardrail) |

All three run the **same** `jira-triage` skill (same rubric, same
`jira.sh`/`gitlab.sh` scripts, same guardrails). Only the invocation and
result-reading differ — that's the whole point of the adapter layer.

> **opencode `run` vs `serve`.** opencode also has a long-lived HTTP server
> (`opencode serve`). We use **`opencode run`** (spawn-per-ticket, exits) because
> it matches the one-ephemeral-run-per-webhook security model; a persistent
> server would be a different integration shape. If you want warm starts,
> `opencode run --attach http://host:port` can front a `serve` daemon without
> changing the adapter. See [harness README](../../agent/runtime/harness/README.md#boundary-this-contract-is-subprocess-shaped).

## How to select

Set `HARNESS` in `agent/deploy/k8s/receiver.yaml`:

```yaml
- name: HARNESS
  value: "pi"        # or "kiro-cli"
```

The harness is a **build layer**, not a runtime switch: the image is built as
base (engine) → `<harness>` (engine + CLI) → `<agent>` (the one agent). Pick the
harness at build time with `make agent-image AGENT=<name> HARNESS=<name>`; the
raw three-step build is shown per harness below.

### Using pi (default)

- **Image:** `make agent-image AGENT=jira-triage HARNESS=pi`.
- **Credential:** none in the pod — the IRSA ServiceAccount supplies Bedrock
  access. Make sure `agent/deploy/terraform`'s `bedrock_model_id` matches `TRIAGE_MODEL`.
- Nothing else to do; this is the path proven end-to-end in the workshop.

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
> your Kiro default-model / agent configuration, so `TRIAGE_MODEL` is ignored for
> this harness. Configure the default model in your Kiro account.

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
   HARNESS=opencode,OPENCODE_MODEL=amazon-bedrock/us.anthropic.claude-sonnet-4-6,AWS_REGION=us-west-2
   ```
   The model id needs the `amazon-bedrock/` provider prefix and the `us.`
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
> `amazon-bedrock/us.anthropic.claude-sonnet-4-6` or
> `anthropic/claude-sonnet-4-6`). The adapter passes it only when the configured
> model contains a `/`; otherwise it falls through to opencode's configured
> default. We use `opencode run`, not `opencode serve` — see the table note above.

## Bring your own harness

The listener selects adapters from `agent/runtime/harness/`. To support a
different CLI, drop in one adapter file (`buildCommand` + optional `interpret` +
`finalize`), register it, install it in the Dockerfile, and set `HARNESS` to its
name. Full guide: **[agent/runtime/harness/README.md](../../agent/runtime/harness/README.md)**.

Next → [Deploy the agent](04-deploy-agent.md)
