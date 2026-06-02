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

### Origin lock (R10b) — **you must verify this**

The public LoadBalancer is locked to CloudFront's origin CIDRs via
`loadBalancerSourceRanges`. Until that's applied, the LB accepts anyone and auth
is the only gate.

- **Confirm:** a direct POST to the LB hostname (bypassing CloudFront) is refused.
- If you front the listener with your own ALB instead, apply the equivalent
  source restriction / WAF there.

### Loop guard (R7)

The agent's own writes are dropped two ways: by the bot `accountId` (resolved at
startup) and, during the cold-start window, by a stateless disclaimer marker in
the comment body. This is why the **bot must be a dedicated account**, not a human.

### Authorization (R6b)

Label-adds are accepted only from accountIds in `AUTHORIZED_ACTORS`. Issue-created
events have **no** per-actor authz (anyone who can create issues can trigger), so
the **daily budget** is the backstop there.

- **Confirm:** who can create issues in the target project, and set
  `DAILY_BUDGET` to a tolerance that matches that exposure.

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

`agent/deploy/k8s/triage-netpol.yaml` default-denies egress and allows only DNS,
in-cluster GitLab, and HTTPS. **But** with the AWS VPC CNI this is enforced only
when the network-policy controller is enabled
(`ENABLE_NETWORK_POLICY=true` on the `aws-node` add-on).

- **Confirm:** the controller is on — otherwise the egress boundary doesn't exist
  and the LB security group (R10b) is your only network control.
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

The listener logs structured events only — no ticket bodies, no PII, no `pi` tool
output. Review before forwarding stdout to a shared sink. If a credential ever
appears in a log, rotate it ([Operations → rotation](05-operations.md#credential-rotation)).

## Pre-launch checklist

The blocking items live in
[Deploy → Pre-launch verification](04-deploy-agent.md#pre-launch-verification-blocking).
Do all of them before the trigger points at a real project.
