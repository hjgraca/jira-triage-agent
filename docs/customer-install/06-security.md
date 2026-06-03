# 06 — Security

The agent runs an LLM, with a shell tool, over **attacker-controllable input**
(ticket text and repository contents). This page is what to confirm in your
environment and the reasoning behind each control. For the layered diagram, see
[Architecture → Trust model](../architecture/README.md#trust-model).

← [Operations](05-operations.md) · [Overview](README.md)

---

## Threat model in one sentence

A malicious ticket (or malicious repo content the ticket points at) could try to
(a) make the agent write damaging field values, (b) leak source/secrets into a
public comment, or (c) exfiltrate the IRSA token or repo data to an attacker host
— so every write is allow-listed, code never enters comments, and egress is
fenced.

## Controls and what you must confirm

### Authentication (both paths constant-time)

- **HMAC** (`X-Hub-Signature`) for system webhooks, **or** a **shared-secret
  bearer** (`X-Triage-Token`) for Cloud Automation rules. Both compared with
  `crypto.timingSafeEqual`.
- A path is only enabled when its secret is set. Use ≥32-byte CSPRNG values
  (`openssl rand -hex 32`).
- **Confirm:** for DC/Server, capture a real `X-Hub-Signature` and verify the
  `sha256=` prefix matches before going live.

### Origin lock — **you must verify this**

Whatever fronts the receiver (CloudFront or your own ALB) must be the *only* path
to the `agent-receiver` Service — lock it to the front door's source ranges
(CloudFront origin CIDRs / your ALB security group / WAF). Until that's applied,
auth is the only gate.

- **Confirm:** a direct request to the Service (bypassing the front door) is refused.

### Receiver privilege (RBAC)

The receiver's only Kubernetes privilege is **create + get Jobs** in the `agents`
namespace (`rbac.yaml`). It cannot read secrets, exec pods, or touch anything
cluster-wide. It also needs **no Jira/cloud credentials** — the loop guard is
stateless (below), so a compromised receiver can at most create gated Jobs.

### Loop guard (R7)

The agent's own writes are dropped **statelessly** — by the agent's loop marker
(`SKILL.md` `loopMarker`) appearing in the triggering comment. No bot-account
lookup, so the receiver makes no `/myself` call. Still use a **dedicated bot
account** so its writes are attributable and the marker is consistently present.

### Authorization (R6b)

Label-adds are accepted only from accountIds in `AUTHORIZED_ACTORS`. Issue-created
events have **no** per-actor authz (anyone who can create issues can trigger), so
the **ResourceQuota** (concurrency) + an **AWS Budget** (cumulative dollars) are
the backstops there.

- **Confirm:** who can create issues in the target project, and set `count/pods`
  + an AWS Budget to a tolerance that matches that exposure.

### Allowed-value sets (R2) — fail closed

The agent can only set labels/priorities/issue-types/assignees you listed in
`config.json`. An out-of-set write is rejected by the script, not retried with a
forced value. Empty `assignees` ⇒ never auto-assigns.

### Severity gate (R2c) and verify-before-write (R2d)

- `high` severity ⇒ the agent applies `needs-human` and **recommends only**, no
  field writes.
- An assignee must tie to a CODEOWNERS owner for the routed component; priority
  must follow the rubric, not the reporter's assertion. Unverifiable changes
  become comment recommendations, not writes.

### No code in comments (R2a)

Repo contents may inform the agent's reasoning but are **never** pasted into a
Jira comment — no file bodies, no secret-looking strings. The skill rubric
enforces this; comments describe code in prose.

### Egress fence (R12) — **conditional on your CNI**

`agent/deploy/k8s/netpol.yaml` default-denies egress and allows only DNS,
in-cluster GitLab, and HTTPS. **But** with the AWS VPC CNI this is enforced only
when the network-policy controller is enabled
(`ENABLE_NETWORK_POLICY=true` on the `aws-node` add-on).

- **Confirm:** the controller is on — otherwise the egress boundary doesn't exist
  and the origin lock is your only network control.
- The bundled policy allows HTTPS to `0.0.0.0/0` (so it can reach Jira/Bedrock
  public endpoints). For a hard exfil boundary, narrow to provider CIDRs or route
  Bedrock via a VPC endpoint and Jira via an egress proxy.

### Least-privilege credentials (R12/R13)

- **Bedrock:** IRSA role scoped to **one model ARN** (never `*`). No static model
  credential exists.
- **GitLab:** a **read-only** deploy token. The agent cannot modify source.
- **Jira:** the bot's permissions should be the minimum to comment/edit/transition
  in the target project.

## Logging hygiene

The receiver and run Jobs log structured events only — no ticket bodies, no PII, no `pi` tool
output. Review before forwarding stdout to a shared sink. If a credential ever
appears in a log, rotate it ([Operations → rotation](05-operations.md#credential-rotation)).

## Pre-launch checklist

The blocking items live in
[Deploy → Pre-launch verification](04-deploy-agent.md#pre-launch-verification-blocking).
Do all of them before the trigger points at a real project.
