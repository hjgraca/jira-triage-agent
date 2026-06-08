---
date: 2026-06-01
topic: eks-workshop-platform
focus: Reusable EKS platform hosting self-managed Jira DC + GitLab, easy reset between customer workshops; provisioning & infrastructure focus
mode: elsewhere-software
---

# Ideation: EKS Workshop Platform for Agentic-Dev (Jira + GitLab)

## Grounding Context

A reusable, repeatable Amazon EKS-based platform that reliably provisions and hosts self-managed Jira (Atlassian Data Center) and GitLab, with easy reset/teardown between customer-workshop sessions. Focus is provisioning & infrastructure (not the agentic-dev workshop content). The customer's environment is treated as a generic enterprise EKS setup (versions/auth/topology unknown). It is a durable platform reused across multiple workshops with easy reset between sessions. The deeper goal: test agentic development in an environment similar to what the customer has.

Key grounding facts and risks (from external research; repo is greenfield with no prior learnings):

* **Jira Data Center licensing is timeboxed, not blocked** — a 30-day evaluation (timebomb) license is available from my.atlassian.com, and the specific target version (10.3.18) is downloadable. The eval expires after 30 days, so the platform needs a license-refresh/reseat step in its lifecycle. Jira DC also needs an external Postgres DB + RWX shared storage (EFS), \~4 CPU/8GB request. Jira Server reached EOL Feb 2024.

## Topic Axes

* cluster-provisioning (IaC tool choice, create/destroy lifecycle)

* stateful-data (DBs, shared storage EFS, Gitaly placement, RDS vs in-cluster)

* app-deploy-reset (Helm/GitOps, seed/snapshot, reproducibility)

* cost-teardown (scale-to-zero, spot, orphaned AWS resource cleanup)

* licensing-access (Jira DC licensing, auth/SSO, ingress/TLS, agent access)

## Ranked Ideas

### 1. Two-tier IaC: durable platform layer + ephemeral session layer

**Description:** Split the IaC into a long-lived stack (VPC, EKS control plane, EFS, RDS, ingress controller, ACM wildcard cert, Karpenter) provisioned once and rarely destroyed, and a thin per-session stack (namespaces, Helm releases, seed jobs) created/reset each workshop. The slow, orphan-prone AWS↔K8s boundary only runs rarely; the frequent reset path touches only fast K8s objects.
**Axis:** cluster-provisioning
**Basis:** `direct:` — "terraform destroy orphans K8s-created LoadBalancers, EBS volumes, ENIs — block VPC deletion." Confining that boundary to a rarely-touched layer removes it from the reset loop.
**Rationale:** The worst failures (hung destroys, ENIs blocking VPC teardown) live at the AWS↔K8s boundary. This is the structural decision the other ideas hang off of.
**Downsides:** Two state files to reason about; the durable layer accrues \~$73/mo control-plane + EFS/RDS baseline even idle (mitigated by #3).
**Confidence:** 88%
**Complexity:** Medium
**Status:** Explored

### 2. Golden-snapshot reset driven by declarative seed-as-code

**Description:** Express the baseline dataset (users, projects, repos, sample issues) as version-controlled fixtures applied via the apps' import APIs. Run the seeder once to produce a golden RDS snapshot (+ EFS golden layer); thereafter reset = restore snapshot (5–15 min), not re-run the importer. The seeder stays the reviewable source of truth; the snapshot is the fast path.
**Axis:** stateful-data
**Basis:** `direct:` — grounding cites RDS golden-snapshot restore (5–15 min) as a reset pattern; GitLab v19 + Jira DC both require external Postgres. `reasoned:` — seed-as-code closes the loop so a 10k-issue Jira resets as fast as an empty one and regenerates cleanly when content changes.
**Rationale:** Decouples reset time from seed complexity, and keeps the baseline diffable instead of an opaque blob.
**Downsides:** Maintaining both seeder and snapshot; restore swaps the DB endpoint (needs app re-point); EFS golden-layer mechanics are fiddlier than RDS.
**Confidence:** 82%
**Complexity:** Medium
**Status:** Unexplored

### 3. Hibernate, don't tear down — scale-to-zero eternal cluster

**Description:** Provision the durable layer once and never `terraform destroy` it. Between/overnight, Karpenter scales data-plane nodes to zero and app Deployments to 0 replicas; a scheduled warm-up scales back \~30 min before a session and restores the snapshot. Idle cost collapses to \~$0.10/hr control plane + storage.
**Axis:** cost-teardown
**Basis:** `direct:` — "Karpenter scale-to-zero, spot"; GitLab's 8 vCPU/30GB floor makes idle compute the dominant avoidable cost. Never destroying sidesteps the entire orphaned-LB/ENI/EBS class.
**Rationale:** Reframes "tear down to save money" as "pause to save money" — near-SaaS economics while preserving seeded state and eliminating the most fragile operation.
**Downsides:** Control plane + EFS/RDS still bill while idle; RDS `stop` auto-restarts after 7 days (needs scheduled restart); spot interruptions need handling for stateful pods.
**Confidence:** 80%
**Complexity:** Low-Medium
**Status:** Unexplored

### 4. Eval-license injection wired into the reset lifecycle (Jira DC 10.3.18)

**Description:** Pin Jira DC to 10.3.18 and treat the 30-day evaluation license as a managed, injectable input: store the eval (timebomb) license in Secrets Manager and inject it at deploy/reset time, with a license-refresh step in the lifecycle so a re-seat is a known operation rather than a surprise expiry mid-workshop. Optionally keep a `profile` knob for a $0 OSS backend (GitLab CE + a Jira-shaped tracker) as a fallback when no eval license is on hand, behind identical ingress URLs.
**Axis:** licensing-access
**Basis:** `direct:` — Jira DC offers a 30-day eval license via my.atlassian.com and 10.3.18 is downloadable (corrected from earlier "no free eval SKU"); the 30-day expiry is the real constraint to design around, not licensing availability.
**Rationale:** The eval license unblocks real Jira DC for workshops today; the only catch is the 30-day clock. Designing license injection + refresh into the reset cycle turns expiry from a blocker into a routine reseat, and the snapshot/reset cadence (ideas #2, #3) is a natural place to re-stamp the license.
**Downsides:** Eval license must be refreshed every 30 days; the license must never bake into a reusable snapshot (inject at deploy, scrub on teardown); repeated fresh installs may need fresh eval keys depending on Atlassian terms.
**Confidence:** 80%
**Complexity:** Medium
**Status:** Unexplored

### 5. One `workshop up|reset|down` CLI with built-in orphan-reaper + inspection gate

**Description:** Wrap all provisioning sequencing behind three verbs. `up` provisions/wakes and waits for health; `reset` snapshot-restores + re-points + runs a health-probe inspection gate before declaring "ready"; `down` runs the dependency-ordered reaper (`kubectl delete svc,ingress`, wait for LB/ENI deletion, then destroy/scale, then a tag-scoped AWS sweep as backstop). The safe path becomes the only path.
**Axis:** app-deploy-reset
**Basis:** `direct:` — every painful step in grounding (delete-order before destroy, snapshot restore, orphan sweep) is a known, scriptable sequence; the orphan ordering is explicitly called out. `reasoned:` — provisioning pain here is sequencing pain humans forget.
**Rationale:** Turns tribal knowledge into a guardrail and makes "repeatable" literally true — a new SA can run a workshop without touching raw terraform/kubectl/aws. The inspection gate (hotel "clean→inspected" analogy) means "ready" = verified-ready, not "apply exited 0."
**Downsides:** CLI is its own software artifact to maintain/test; risk of becoming a leaky abstraction over Terraform; the reaper needs careful tag-scoping to never delete out-of-scope resources.
**Confidence:** 81%
**Complexity:** Medium
**Status:** Unexplored

### 6. Eject GitLab to an Omnibus sidecar VM, keep Jira on EKS

**Description:** Since the GitLab Helm chart is heavy (8 vCPU/30GB, stateful parts external, Fargate-incompatible, Gitaly-on-K8s non-HA) and GitLab itself recommends Omnibus-on-VM below 3000 users, run GitLab as a single Omnibus EC2 instance reset via AMI/EBS-snapshot swap. EKS hosts Jira + workshop apps. The platform orchestrates both.
**Axis:** cluster-provisioning
**Basis:** `external:`/`direct:` — GitLab docs recommend Omnibus-on-VM below 3000 users; grounding confirms chart weight, Gitaly non-HA, Fargate exclusion.
**Rationale:** Removes the single heaviest, most failure-prone workload from K8s for workshop-scale usage, shrinking node requirements and eliminating a whole class of Helm-on-EKS failure modes.
**Downsides:** Tension with the goal — if the workshop is meant to demonstrate EKS-hosted tooling, ejecting GitLab undercuts fidelity. Best when the customer's GitLab isn't itself on K8s. Adds a non-K8s component to the orchestration.
**Confidence:** 68%
**Complexity:** Low-Medium
**Status:** Unexplored

## Rejection Summary

| #  | Idea                                                                                                             | Reason Rejected                                                               |
| :- | :--------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------- |
| 1  | Atlassian Cloud + GitLab.com SaaS sandboxes                                                                      | Subject-replacement — user wants EKS hosting both apps                        |
| 2  | Per-attendee kind/k3s clusters                                                                                   | Subject-replacement — scope is one shared EKS cluster                         |
| 3  | Nightly self-destruct cluster                                                                                    | Contradicts #3 survivor; higher orphan/cost risk for intermittent use         |
| 4  | Two-tier AMI bakery / co-versioned "session image" / CoW Aurora fast-clone / video-game delta / overlay-FS reset | Folded into survivor #2 as implementation variants of fast reset              |
| 5  | Workshop-as-a-PR / namespace-per-cohort GitOps                                                                   | Strong, but the GitOps mechanism folds into survivors #1 + #5                 |
| 6  | Standalone reaper / drain hook / aviation auto-teardown / tagged sweeper                                         | Folded into survivor #5's `down` verb                                         |
| 7  | "Similar to customer = config profile"                                                                           | Folded into survivor #4                                                       |
| 8  | Library-lending license seats / clean-room secret airlock / secrets vending machine                              | Folded into survivor #4's BYOL injection                                      |
| 9  | Warm fixture pool                                                                                                | Deferred — idle cost hard to justify for single-session-at-a-time reality     |
| 10 | "Platform provisions itself via the agentic loop it teaches"                                                     | Compelling but it's workshop content, out of the provisioning/infra scope set |

Axis coverage: all five axes represented across survivors (cluster-provisioning ×2, stateful-data, cost-teardown, app-deploy-reset, licensing-access) — no gaps.
