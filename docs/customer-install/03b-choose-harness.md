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
| Model backend | **Amazon Bedrock** via IRSA (no key in pod) | Kiro's own backend (**`KIRO_API_KEY`**) | any provider (provider key / `auth.json`) |
| Subscription | AWS Bedrock model access | Kiro **Pro / Pro+ / Power** | provider account (e.g. Anthropic) |
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

Set `HARNESS` in `agent/deploy/k8s/triage-listener.yaml`:

```yaml
- name: HARNESS
  value: "pi"        # or "kiro-cli"
```

…and make sure the image is built from that harness's Dockerfile (each harness
has its own under `agent/deploy/docker/`, all built FROM a shared `base.Dockerfile`),
and the required credential is present. The simplest path is `make triage-image
HARNESS=<name>`; the raw two-step build is shown per harness below.

### Using pi (default)

- **Image:** `make triage-image HARNESS=pi` (or build `base.Dockerfile` then
  `pi.Dockerfile`).
- **Credential:** none in the pod — the IRSA ServiceAccount supplies Bedrock
  access. Make sure `agent/deploy/terraform`'s `bedrock_model_id` matches `TRIAGE_MODEL`.
- Nothing else to do; this is the path proven end-to-end in the workshop.

### Using kiro-cli

1. **Build the image with kiro:**
   ```bash
   make triage-image HARNESS=kiro
   # or, raw: build the base, then the kiro image FROM it
   docker buildx build --platform linux/amd64 \
     -f agent/deploy/docker/base.Dockerfile -t triage-base:local --load agent
   docker buildx build --platform linux/amd64 \
     -f agent/deploy/docker/kiro.Dockerfile --build-arg BASE=triage-base:local \
     -t "$REPO:latest" --push agent
   ```
2. **Add the API key** to `agent/deploy/k8s/triage-secrets.yaml`:
   ```yaml
   kiro-api-key: "ksk_xxxxxxxx"   # from https://app.kiro.dev
   ```
   The listener already maps it to `KIRO_API_KEY` (`optional: true`, so pi
   deployments are unaffected).
3. **Set the harness:** `HARNESS: "kiro-cli"` in the listener manifest.
4. Apply secret + listener and roll the deployment.

> **Model on kiro:** `kiro-cli chat` has no `--model` flag — the model comes from
> your Kiro default-model / agent configuration, so `TRIAGE_MODEL` is ignored for
> this harness. Configure the default model in your Kiro account.

> **Governance:** any MCP / model / web-fetch policies your Kiro administrator
> sets apply to headless sessions too. If your pipeline depends on MCP servers,
> the adapter can be extended to pass `--require-mcp-startup` (fail fast).

### Using opencode

1. **Build the image with opencode:**
   ```bash
   make triage-image HARNESS=opencode
   # or, raw:
   docker buildx build --platform linux/amd64 \
     -f agent/deploy/docker/base.Dockerfile -t triage-base:local --load agent
   docker buildx build --platform linux/amd64 \
     -f agent/deploy/docker/opencode.Dockerfile --build-arg BASE=triage-base:local \
     -t "$REPO:latest" --push agent
   ```
2. **Add the provider key** to `agent/deploy/k8s/triage-secrets.yaml`:
   ```yaml
   opencode-provider-key: "<your provider API key>"   # e.g. an Anthropic key
   ```
   The listener maps it to **`ANTHROPIC_API_KEY`** by default. For a different
   provider, change that env `name:` in `triage-listener.yaml` to the var
   opencode's provider expects (run `opencode models` to see provider/model ids).
3. **Set the harness + model:** `HARNESS: "opencode"`, and set the model in
   `provider/model` form via `OPENCODE_MODEL` (or `TRIAGE_MODEL` if it already
   has a provider prefix). A bare model id is ignored — opencode requires the
   provider prefix.
4. Apply secret + listener and roll the deployment.

> **Model on opencode:** `opencode run` needs `--model provider/model` (e.g.
> `anthropic/claude-sonnet-4-6`). The adapter passes it only when the configured
> model contains a `/`; otherwise it falls through to opencode's configured
> default. We use `opencode run`, not `opencode serve` — see the table note above.

## Bring your own harness

The listener selects adapters from `agent/runtime/harness/`. To support a
different CLI, drop in one adapter file (`buildCommand` + optional `interpret` +
`finalize`), register it, install it in the Dockerfile, and set `HARNESS` to its
name. Full guide: **[agent/runtime/harness/README.md](../../agent/runtime/harness/README.md)**.

Next → [Deploy the agent](04-deploy-agent.md)
