# Architecture

How the triage agent is put together, how a request flows through it, and the
trust model that keeps an LLM-with-tools acting on real tickets safe.

The same **agent** runs in two deployment shapes:

- **Workshop** — a self-contained lab: EKS + self-hosted GitLab + the agent, all
  built by `workshop/terraform` and the `Makefile`.
- **Customer** — the agent only, installed into a cluster the customer already
  runs, against their existing GitLab/Jira. Built by `agent/deploy/terraform` + `agent/deploy/k8s`.

The agent's internals (listener, skill, guardrails) are identical in both; only
what surrounds it differs.

---

## The runner is generic: trigger × agent × harness

The listener is **not** triage-specific. It's a generic runner composed of three
independently-pluggable pieces, so you change behavior by configuration, not code:

```
   TRIGGER                 AGENT (the skill)              HARNESS
   how an event is         what the agent IS:             which coding-agent
   authenticated,          its prompt + rubric +          CLI actually runs
   parsed into vars,       tools, declared in             the prompt
   and gated               SKILL.md frontmatter
   ───────────             ──────────────────             ──────────────
   jira (default)          jira-triage (default)          pi (default)
   generic                 <your skill dir>               kiro-cli
   <your adapter>                                         opencode
                                                          <your adapter>
```

- **The skill drives the agent.** `SKILL.md`'s YAML frontmatter (`prompt`,
  `loopMarker`, `authorizedActors`, `trustTools`, `model`) IS the agent
  definition — see [agent-def.js](../../agent/runtime/listener/agent-def.js). Point
  `AGENT_PATH` at a different skill → a different agent, no code change. The
  prompt is a template; `{{vars}}` are filled from the trigger.
- **The trigger feeds it.** `TRIGGER` selects how the webhook is authenticated,
  parsed into prompt vars, and gated. `jira` carries the Jira eligibility / loop
  guard / actor-allowlist logic; `generic` is a signed-POST passthrough for
  non-Jira sources.
- **The harness runs it.** `HARNESS` selects the coding-agent CLI.

The runner core (auth, dedupe, spend limiter, watchdog, ack-fast lifecycle) is
the same regardless of the three choices.

## Components

| Component | Path | Role |
|---|---|---|
| **Listener (HTTP shell)** | `agent/runtime/listener/server.js` | Generic I/O shell + startup. Per request: `trigger.authenticate` → parse → dedupe → `trigger.decide` (gate) → spend limiter → ack fast → `spawnRun`. Zero third-party deps. |
| **Runner (run lifecycle)** | `agent/runtime/listener/runner.js` | The per-run invariants in one place: render prompt → spawn harness child → watchdog kill → release the limiter slot exactly once → stream-parse/classify → evict dedupe id on spawn failure. `createRunner(deps)` is what `server.js` calls. |
| **Auth** | `agent/runtime/listener/auth.js` | Constant-time HMAC + shared-secret verification (trigger-agnostic). |
| **Agent definition** | `agent/runtime/listener/agent-def.js` + a skill's `SKILL.md` frontmatter | Parses the skill's frontmatter into `{ prompt, loopMarker, authorizedActors, trustTools, model, body }` and renders the prompt template. The skill, not the code, defines the agent. |
| **Trigger adapters** | `agent/runtime/trigger/` | `index.js` registry (`TRIGGER` env, default `jira`); `jira.js` (webhook/Automation auth + eligibility + loop guard + authz); `generic.js` (signed-POST passthrough). Add an event source with one file. |
| **Skill / agent** | `agent/agents/jira-triage/` | The default agent: `SKILL.md` (frontmatter + triage rubric + trust boundary), bundled scripts `jira.sh` / `gitlab.sh`, and its own `Dockerfile`. One dir per agent. |
| **Harness adapters** | `agent/runtime/harness/` | Pluggable coding-agent CLIs (`HARNESS` env; default `pi`; `kiro-cli` + `opencode` built in). Each owns argv + result-reading. Skill-less harnesses share `inline-skill.js`. Contract is subprocess-shaped (spawn-per-ticket) — see the [harness README](../../agent/runtime/harness/README.md). |
| **Image** | `agent/deploy/docker/` + `agent/agents/<name>/Dockerfile` | Three agent-blank-until-last layers: `base.Dockerfile` (engine only) → `<harness>.Dockerfile` (+ CLI) → the agent's own Dockerfile (+ one agent). `make triage-image AGENT=<name> HARNESS=<name>`. |
| **Manifests** | `agent/deploy/k8s/` | Namespace + IRSA ServiceAccount, listener Deployment + dedicated LoadBalancer, NetworkPolicy (ingress + egress allowlist), ConfigMap/Secret. |
| **Cloud deps** | `agent/deploy/terraform/` | Bedrock IRSA role (scoped to one model) + optional CloudFront for a domain-free HTTPS webhook endpoint. |

---

## Topology — customer install (agent only)

```mermaid
flowchart LR
  subgraph Jira["Jira (Cloud or Data Center)"]
    R[Automation rule / system webhook]
  end
  subgraph AWS["Customer AWS account"]
    CF[CloudFront\nor customer ALB+TLS]
    subgraph EKS["Existing EKS cluster"]
      subgraph NS["namespace: triage"]
        LB[Dedicated LoadBalancer\nlocked to CloudFront CIDRs]
        L[Listener pod\nIRSA ServiceAccount]
        L -. spawns .-> PI[pi run\njira-triage skill]
      end
    end
    BR[Amazon Bedrock\nInvokeModel scoped to 1 model]
  end
  subgraph SRC["Customer GitLab"]
    G[REST v4\nread-only]
  end

  R -->|POST + auth header| CF --> LB --> L
  PI -->|IRSA, no static cred| BR
  PI -->|read-only routing + code| G
  PI -->|comment / set fields / remove label| Jira
```

The workshop topology is the same picture with two additions: GitLab runs
**inside** the cluster (Helm), and CloudFront + the cluster are created together
by one `workshop/terraform` apply.

---

## Request flow — label-add to triaged ticket

```mermaid
sequenceDiagram
  participant U as User
  participant J as Jira
  participant CF as CloudFront
  participant L as Listener
  participant P as pi run (skill)
  participant G as GitLab
  participant B as Bedrock

  U->>J: add `triage` label
  J->>CF: POST webhook (+ auth header, initiator accountId)
  CF->>L: forward (origin-locked)
  Note over L: 1. authenticate (HMAC OR shared secret)<br/>2. loop guard (bot self-write)<br/>3. eligibility (created / label-added)<br/>4. authz (actor allowlist)<br/>5. dedupe (delivery id)<br/>6. rate + daily budget
  L-->>CF: 200 ack (fast)
  L->>P: spawn `pi --mode json` for this issue key
  P->>J: read ticket (summary, description, comments)
  P->>G: read-only: route, tree, file content, CODEOWNERS
  P->>B: classify + reason (InvokeModel via IRSA)
  Note over P: severity gate + verify-before-write<br/>allowed-value sets (fail closed)
  P->>J: post audit comment + set fields (within allow-list)
  P->>J: remove `triage` label (queue flag cleared)
```

---

## Trust model

The agent runs an LLM, with a shell tool, over **attacker-controllable input**
(ticket text and repository contents). The defenses, in layers:

| # | Guard | What it stops |
|---|---|---|
| Auth | HMAC (`X-Hub-Signature`) **or** constant-time shared secret (`X-Triage-Token`) | Forged/unauthenticated webhooks. Both compared in constant time. |
| R10b | LoadBalancer locked to CloudFront origin CIDRs | Direct POSTs to the public LB, bypassing the front door. |
| R7 | Loop guard — bot `accountId` + stateless disclaimer marker | The agent triggering itself in an infinite loop on its own comment. |
| R6b | Actor allowlist (`AUTHORIZED_ACTORS`) on label-add | Anyone who can edit labels spending Bedrock tokens. |
| R8 | Dedupe (≥24h TTL) on delivery id | Replays and Jira retries double-triaging. |
| R10c | Concurrency semaphore + rate ceiling + **daily budget** | A label storm or loop running up unbounded model spend. |
| R2 | Allowed-value sets (labels/priorities/issue-types/assignees), **fail closed** | The agent writing arbitrary or invented field values. |
| R2c | Severity gate — `high` ⇒ `needs-human`, no field writes | Autonomous action on the riskiest tickets. |
| R2d | Verify-before-write (assignee tied to CODEOWNERS, priority to rubric) | Acting on the reporter's say-so or a prompt injection. |
| R2a | Skill rubric: repo code informs reasoning, **never** pasted into a comment | Source/secret leakage into a Jira comment. |
| R12 | Egress NetworkPolicy + IRSA scoped to one model | Exfiltration of the IRSA token or repo contents to an arbitrary host. |
| — | GitLab token is **read-only**, minimum privilege | The agent modifying source. |

> **Why two auth paths?** Jira Cloud **Automation rules** can't compute an HMAC
> over the request body, so they authenticate with the shared-secret header.
> Jira **Data Center / Server** system webhooks sign with HMAC. The listener
> accepts either, so the same image works for both — see
> [Configure Jira](../customer-install/03-configure-jira.md).

## Design decisions worth knowing

- **Pluggable harness, fixed skill.** The triage *rubric* and the
  `jira.sh`/`gitlab.sh` *scripts* are harness-neutral, so swapping the coding
  agent (pi ↔ kiro-cli ↔ your own) changes only *invocation* and *result-reading*
  — encapsulated in a ~40-line adapter. Streaming harnesses parse events
  (`interpret`); non-streaming ones classify from the exit code (`finalize`).
  Harnesses without a skill-loader (kiro-cli) get the rubric inlined into the
  prompt. This is what makes it plug-and-play for customers.
- **Single replica, in-memory state.** Dedupe and the spend limiter are per-pod
  and in-memory, so the Deployment is pinned to `replicas: 1` with a `Recreate`
  strategy (two pods would each dedupe/limit independently). Scaling out requires
  moving that state to a shared store first.
- **Ack fast, work async.** The listener returns `200` before spawning `pi`, so
  Jira's webhook never times out waiting on a model run.
- **No domain required.** CloudFront's default `*.cloudfront.net` cert gives a
  valid-TLS public endpoint with no domain purchase; TLS terminates at CloudFront
  and the origin hop is plain HTTP inside the VPC. Customers who already have a
  domain + ALB can skip CloudFront entirely.
