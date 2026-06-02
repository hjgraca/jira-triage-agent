# 03b — Choose Your Harness

The agent's "brain" is a headless coding-agent CLI that the listener spawns once
per ticket. It's **pluggable** — the listener is harness-agnostic, so you pick the
one that fits your subscription and model story. Two are built in; adding a third
is a small adapter file.

← [Configure Jira](03-configure-jira.md) · Next → [Deploy the agent](04-deploy-agent.md)

---

## Built-in harnesses

| | **pi** (default) | **kiro-cli** |
|---|---|---|
| Project | [pi.dev](https://github.com/earendil-works/pi) | [kiro.dev](https://kiro.dev) |
| Model backend | **Amazon Bedrock** via IRSA (no key in the pod) | Kiro's own backend via **`KIRO_API_KEY`** |
| Subscription | AWS Bedrock model access | Kiro **Pro / Pro+ / Power** (API key enabled) |
| Skill loading | native `--skill <path>` | rubric **inlined** into the prompt (no skill flag) |
| Output | streaming JSON events | final response only; result from **exit code** |
| Model selection | `TRIAGE_MODEL` env | set via Kiro default-model/agent config (`TRIAGE_MODEL` ignored) |
| Tool trust | n/a (skill scripts) | `--trust-tools=read,execute_bash` (least privilege) |

Both run the **same** `jira-triage` skill (same rubric, same `jira.sh`/`gitlab.sh`
scripts, same guardrails). Only the invocation and result-reading differ.

## How to select

Set `HARNESS` in `agent/k8s/triage-listener.yaml`:

```yaml
- name: HARNESS
  value: "pi"        # or "kiro-cli"
```

…and make sure the image has that harness baked in (build args, below), and the
required credential is present.

### Using pi (default)

- **Image:** `--build-arg INSTALL_PI=true` (the default).
- **Credential:** none in the pod — the IRSA ServiceAccount supplies Bedrock
  access. Make sure `agent/terraform`'s `bedrock_model_id` matches `TRIAGE_MODEL`.
- Nothing else to do; this is the path proven end-to-end in the workshop.

### Using kiro-cli

1. **Build the image with kiro:**
   ```bash
   docker buildx build --platform linux/amd64 \
     --build-arg INSTALL_KIRO=true \
     -f agent/docker/triage/Dockerfile -t "$REPO:latest" --push agent
   ```
   (Set `--build-arg INSTALL_PI=false` if you don't also want pi.)
2. **Add the API key** to `agent/k8s/triage-secrets.yaml`:
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

## Bring your own harness

The listener selects adapters from `agent/listener/src/harness/`. To support a
different CLI, drop in one adapter file (`buildCommand` + optional `interpret` +
`finalize`), register it, install it in the Dockerfile, and set `HARNESS` to its
name. Full guide: **[agent/listener/src/harness/README.md](../../agent/listener/src/harness/README.md)**.

Next → [Deploy the agent](04-deploy-agent.md)
