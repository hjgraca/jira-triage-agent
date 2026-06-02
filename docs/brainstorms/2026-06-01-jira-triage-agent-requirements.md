---
date: 2026-06-01
topic: jira-triage-agent
---

# Jira Triage Agent on pi.dev (EKS)

## Summary

A triage agent built on the pi.dev coding harness, running in the existing EKS
cluster. When a Jira Cloud ticket is created or moved into a triage state, a
webhook triggers a one-shot pi run that reads the ticket, consults the GitLab
source to inform routing, then **applies** classification (severity, category,
priority, assignee) to the Jira ticket and posts a comment explaining its
reasoning. First concrete agent on the workshop platform and a demonstration of
agentic development against a customer-like environment.

## Problem Frame

The workshop platform (EKS + GitLab + Jira Cloud) exists to test agentic
development in an environment resembling a customer's. So far it hosts the
tools but runs no agents. Incoming tickets in a real backlog are triaged by
hand — someone reads each one, decides severity and category, checks for
duplicates and missing information, sets priority, and routes it to an owner.
That work is repetitive, latency-prone (tickets sit untriaged), and depends on
tribal knowledge of which part of the codebase owns which problem. A triage
agent that runs the moment a ticket lands both removes that toil and serves as
the platform's first worked example of an agent with real read/write access to
the customer's systems.

## Key Decisions

- **PM-grade triage, not code archaeology or auto-fix.** The agent's output is
  classification and routing: severity, category, duplicate detection,
  missing-information flags, and suggested/applied priority and assignee. It
  does not perform deep code root-causing or attempt fixes/MRs. Those are
  possible later use cases, explicitly out of scope for v1.

- **Webhook-triggered, not polled or manual.** Jira Cloud fires a webhook on
  issue creation (and selected transitions); a small always-on listener in the
  cluster launches a pi run per ticket. Chosen for near-real-time triage over
  the simpler poll/manual options.

- **Public ingress via CloudFront's default domain — no domain purchase.** The
  webhook requires Jira Cloud (public internet) to make an inbound HTTPS call to
  the listener with a *valid* TLS certificate. Rather than buying a domain, a
  CloudFront distribution's default `*.cloudfront.net` hostname (which ships with
  an AWS-managed valid cert) fronts the existing public nginx ELB over HTTP.
  Jira does not care about the hostname, only that the cert is trusted. This
  keeps everything inside the AWS account with nothing to purchase. Trade-off:
  the `*.cloudfront.net` URL is public and scannable, which makes webhook
  authentication (R10) load-bearing rather than optional.

- **The agent acts, then explains.** It applies labels/priority/assignee
  directly via the Jira API and posts a comment with its reasoning — not
  suggest-only. This raises the stakes (mutations land on real tickets) and
  drives the mutation-safety and feedback-loop requirements below.

- **GitLab source access is first-class.** Routing genuinely depends on
  understanding the code (mapping a reported problem to the owning
  module/component), so the agent needs reliable read access to the GitLab
  repo — not an optional nicety.

- **Model: Amazon Bedrock via IRSA.** pi runs with `--provider amazon-bedrock`
  in region `us-west-2`. The pod's ServiceAccount is bound to an IAM role with
  `bedrock:InvokeModel` (IRSA) — no static model credential to store or rotate.
  Anthropic direct API is not used.

- **No MCP — capabilities are pi skills.** pi has no MCP support. Jira and
  GitLab access, and the triage rubric itself, are delivered as pi skills
  (`SKILL.md` directories with bundled scripts that call the Jira REST API and
  read the GitLab repo). The triage behavior is a versioned skill, not
  hard-coded.

- **pi is one-shot; only the listener is long-running.** pi runs a single task
  and exits (`pi --mode json "<prompt>"`). The always-on component is therefore
  the lightweight webhook listener (a Deployment); each triage is a short-lived
  pi process/Job the listener spawns. "pi as a Deployment" does not fit pi's
  execution model.

## Actors

- A1. **Reporter** — the human (or system) that creates/updates a Jira ticket,
  unknowingly triggering triage.
- A2. **Jira Cloud** — fires webhooks outbound to the listener; exposes the REST
  API the agent reads and writes.
- A3. **Webhook listener** — always-on in-cluster service; authenticates
  incoming webhooks and spawns a pi triage run per eligible ticket.
- A4. **Triage agent (pi run)** — short-lived process that reads the ticket,
  reads GitLab source, classifies, and writes back to Jira.
- A5. **Triage bot Jira account** — the dedicated Jira identity the agent uses
  to comment and mutate, distinct from human accounts (load-bearing for the
  feedback-loop guard).
- A6. **Human triager / reviewer** — reads the agent's comment and applied
  changes; the audience the explanation comment serves.

## Key Flows

- F1. **Happy-path triage.**
  - **Trigger:** Reporter creates a ticket (or transitions it into the triage
    state).
  - Jira Cloud sends a webhook to the listener over public HTTPS.
  - Listener authenticates the webhook (shared secret/HMAC), checks event
    eligibility, and spawns a pi run scoped to that ticket key.
  - Agent loads the triage skill, fetches ticket data via the Jira API, and
    reads relevant GitLab source to inform routing.
  - Agent applies severity/category/priority/assignee within the allowed value
    set and posts a comment stating its classification and reasoning.
  - Run exits; listener returns to idle.

- F2. **Feedback-loop suppression.**
  - **Trigger:** The agent's own write (F1) updates the ticket, which causes
    Jira to fire another webhook.
  - Listener (or event filter) detects the update originated from the triage
    bot account (A5) and/or is not an eligible event type, and drops it without
    spawning a run.

- F3. **Ineligible / duplicate event.**
  - **Trigger:** A webhook arrives for an event outside the trigger scope, or
    for a ticket already triaged.
  - Listener drops it (or the agent no-ops idempotently) without mutating the
    ticket.

## Requirements

**Triage behavior**

- R1. On an eligible Jira event, the agent produces a classification covering:
  severity, category, duplicate likelihood, missing-information flags, and a
  routing decision (priority + assignee).
- R2. The agent applies its classification to the Jira ticket via the API,
  writing four fields: **priority, labels, assignee, and issue type**. Each is
  constrained to a pre-approved value set (allowed priorities, an allowed label
  list, a defined assignee pool, allowed issue types) — the agent picks within
  those sets, never free-form. Issue-type changes carry the most risk (they can
  alter required fields/workflow), so the audit comment (R3) must always state
  an issue-type change explicitly for easy human override.
- R3. The agent posts a single comment per triage run explaining its reasoning
  and listing exactly which fields it changed (audit trail).
- R4. Routing decisions may draw on the GitLab source; the agent has reliable
  read access to the repo to map a reported problem to an owning
  component/module.
- R5. The triage rubric (prompt + classification rules + allowed values) is
  delivered as a versioned pi skill, editable without rebuilding the harness.

**Trigger and event handling**

- R6. A Jira Cloud webhook triggers triage in two cases: (a) issue creation,
  and (b) when a designated trigger label (e.g. `triage`) is added to an
  existing ticket. The label is the re-queue mechanism — no status-workflow
  change is required to send any ticket to the agent.
- R6a. On completing a run, the agent removes the trigger label so the ticket
  is no longer eligible. Because that removal is a write from the triage bot
  account, R7's suppression prevents it from re-triggering. The trigger label
  thus acts as a work-queue flag: present = needs triage, absent = done.
- R7. A webhook caused by the agent's own write MUST NOT trigger another
  triage run (feedback-loop suppression), identified by the triage bot account
  and/or event-type filtering.
- R8. Ineligible or duplicate events are dropped without mutating the ticket;
  re-triggering triage on an already-triaged ticket is idempotent (no
  conflicting or duplicated changes/comments).

**Deployment and access**

- R9. The webhook listener is an always-on in-cluster service reachable by Jira
  Cloud over public HTTPS. Public reach and a valid TLS cert are provided by a
  CloudFront distribution (default `*.cloudfront.net` domain, AWS-managed cert)
  whose origin is the existing public nginx ELB over HTTP; the listener is
  exposed through a `gitlab-nginx` ingress route. No custom domain or
  separately-issued certificate is required.
- R10. The webhook endpoint authenticates every request (shared secret/HMAC);
  unauthenticated calls are rejected so the public trigger cannot be abused.
- R11. Each triage runs as a short-lived pi process/Job that exits on
  completion; no triage state persists between runs in the pod.
- R12. pi authenticates to Bedrock via IRSA (pod ServiceAccount → IAM role with
  `bedrock:InvokeModel`, region `us-west-2`); no static model credential is
  stored.
- R13. The Jira API token and GitLab read token are stored as Kubernetes
  Secrets and mounted into the triage run; they are the only long-lived
  application credentials.

## Acceptance Examples

- AE1. **Covers R6, R7.** A reporter creates `KAN-5`. The listener authenticates
  the webhook and spawns a triage run. The agent applies a `bug` label, sets
  priority `High`, assigns an owner, and comments its reasoning. That write
  fires a second webhook; the listener sees it came from the triage bot account
  and drops it — no second run.
- AE2. **Covers R2, R3.** The agent decides a ticket is severity `Low`, category
  `documentation`. It sets only those allowed fields and posts one comment that
  names each changed field and why. A field outside the allowed set is never
  written.
- AE3. **Covers R8.** A webhook arrives for a ticket the agent already triaged
  (e.g., a later comment-add event). The run no-ops: no duplicate comment, no
  re-classification churn.
- AE4. **Covers R10.** A request hits the public webhook URL without the shared
  secret. The listener rejects it and spawns no run.
- AE5. **Covers R4.** A ticket reports an error message. The agent reads the
  GitLab repo, finds the owning module, and routes the ticket to that
  component's owner — the routing reflects code knowledge, not just ticket text.

## Scope Boundaries

**Deferred for later (not v1)**

- Deep code root-cause analysis with file/function-level pointers.
- Drafting fixes or opening GitLab merge requests from a ticket.
- Jira → GitLab "development panel" two-way integration beyond what the webhook
  ingress incidentally enables.
- Triage of pre-existing backlog tickets in bulk (v1 is event-driven: new
  tickets, or existing tickets re-queued one at a time via the trigger label).

**Outside this use case**

- Replacing human judgment on contested or high-severity tickets — the agent
  classifies and routes; humans retain override via the audit comment.

## Dependencies / Assumptions

- Public ingress for the listener: a CloudFront distribution fronting the
  existing nginx ELB (origin `a79e781b91cec477999faab70a91e423-290080759.us-west-2.elb.amazonaws.com`),
  using the default `*.cloudfront.net` domain + AWS-managed cert. Net-new infra
  (Terraform), but no domain purchase and no separate certificate issuance.
  Prerequisite for the webhook trigger.
- An IRSA IAM role + policy for Bedrock access, provisioned in Terraform
  (the existing EBS CSI IRSA module is the pattern to follow).
- A dedicated Jira "triage bot" account with API token and permission to
  comment and edit issue fields; its identity is what feedback-loop
  suppression keys on.
- A GitLab read-only access token (or deploy token) scoped to the repos the
  agent routes against.
- The target Bedrock model is available/enabled in `us-west-2` for the account.
- pi runs headlessly via `--mode json` and is packaged into a container image
  with the triage skill and its scripts bundled.

## Outstanding Questions

**Resolve before planning**

- The concrete allowed *values* per field (R2): the exact label list, priority
  scheme, assignee pool, and allowed issue types. The agent writes all four
  fields; planning needs the bounded value sets. Likely the stock `KAN`
  defaults (priorities Highest…Lowest; types Bug/Story/Task) plus a curated
  label list — confirm during planning against the live project.

**Deferred to planning**

- A dedicated listener path/route on the ELB so CloudFront forwards only the
  webhook path (not the whole GitLab surface), and whether to lock the
  listener's ingress to CloudFront's IP ranges as defense-in-depth alongside
  R10's HMAC.
- Listener implementation shape (how it spawns runs: Kubernetes Job per ticket
  vs in-pod subprocess) and concurrency/queueing under burst.
- Container image build/packaging for pi + skills.
- Specific Bedrock model ID and cost/latency envelope per triage.
- Observability: where triage run logs/outcomes are recorded.

## Sources / Research

- pi.dev docs — harness overview, headless `--mode json` (one-shot run-and-exit),
  skills model (`SKILL.md` dirs + bundled scripts, progressive disclosure, no
  MCP), and Bedrock provider support incl. IRSA
  (`AWS_WEB_IDENTITY_TOKEN_FILE`): https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/index.md
- Existing platform context: `helm/gitlab-values.yaml` (GitLab + nginx ingress,
  all-namespace scope), `terraform/` (EKS + EBS CSI IRSA module as the IRSA
  pattern), `README.md` "Jira Cloud integration" (one-way GitLab→Jira; reverse
  needs public DNS+TLS — same prerequisite as R9).
- `docs/ideation/2026-06-01-eks-workshop-platform-ideation.md` — platform goal:
  test agentic development in a customer-like environment.
