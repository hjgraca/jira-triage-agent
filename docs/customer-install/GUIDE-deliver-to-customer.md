# Delivery Guide — Getting the Agent to the Customer (private repo)

How to hand the agent to Brisa **without exposing your private monorepo** (the
`workshop/` lab, the HLD, ADRs, internal notes). Written for the chosen model:
**the customer self-serves changes**, so they need the *code as a living repo*,
not a one-time file.

---

## The deliverable boundary (what's verified)

`agent/` is **self-contained** — it does not need `workshop/` to build or run.
The deliverable is exactly:

```
agent/                    # the shippable unit (runtime, agents, deploy manifests, terraform)
docs/customer-install/    # all the install/operate/configure guides
```

Everything else — `workshop/`, `docs/hld/`, `docs/decisions/`, `docs/brainstorms/`,
the root `Makefile`'s lab targets — **stays private**. The subset is 59 tracked
files and contains **no secrets** (only `*.example` templates are committed; real
`secrets.yaml`/`config.yaml`/`*.tfvars` are gitignored).

> ⚠️ **Commit first.** All the commands below operate on *tracked* files. The DC
> variant (`agent/agents/jira-triage-dc/`, `agent/runtime/trigger/jira-dc.js`,
> `agent/deploy/k8s/dc/`, the new docs) is currently **uncommitted** — it will
> NOT be included until you commit it. Run `git add -A && git commit` (on a
> branch, then merge) before delivering.

---

## Delivery model: you hand over an artifact; THEY import it

> **Constraint (Brisa):** you will **not** have access to the customer's GitLab,
> ECR, or cluster — and don't want it. So **you never push to their side.** You
> produce a clean, self-contained **artifact** from your repo and hand it across
> the boundary. The customer imports it into *their* GitLab and builds the image
> on *their* host. The boundary stays clean: nothing of yours reaches into their
> tools, and nothing of theirs (creds, kubeconfig, registry) reaches into yours.

```
   YOU (private repo)                    │  handoff  │      CUSTOMER (their boundary)
   ─────────────────────                 │  artifact │      ──────────────────────────
   git archive → triage-agent-<sha>.tar.gz ─────────────►   import into their GitLab
                                          │           │      build image on their host
   (you never touch their GitLab/ECR/k8s) │           │      kubectl apply in their cluster
```

### Step 1 (YOU) — produce the artifact

`git archive` emits a clean, versioned tree (**no `.git`, no history, no
`workshop/`, no internal docs**) selecting both deliverable paths at once:

```bash
cd <your-monorepo>
git checkout main && git pull --ff-only          # deliver the merged code
git archive --format=tar.gz \
  --prefix=brisa-triage-agent/ \
  -o brisa-triage-agent-$(git rev-parse --short HEAD).tar.gz \
  HEAD agent docs/customer-install
# → brisa-triage-agent-<sha>.tar.gz   (agent/ + docs/customer-install/ ONLY)
```

The `<sha>` in the filename is the version — it tells you (and them) exactly which
commit they're running, and makes "what changed since last drop" answerable.

### Step 2 (YOU) — verify before it leaves your hands

Always look inside what you hand over. This proves no secrets and no private dirs
slipped in:

```bash
# contents (should be ONLY agent/ + docs/customer-install/)
tar tzf brisa-triage-agent-*.tar.gz | sed 's,brisa-triage-agent/,,' | cut -d/ -f1-2 | sort -u

# no secrets / state / private dirs
tar tzf brisa-triage-agent-*.tar.gz \
  | grep -E "secrets\.yaml$|config\.yaml$|\.tfvars$|tfstate|workshop/|docs/hld|docs/decisions|\.claude/" \
  | grep -v example \
  && echo "STOP: something private slipped in" || echo "clean — only example templates + deliverable ✅"
```

### Step 3 (YOU → CUSTOMER) — move the bytes across

The artifact is just one file, so the channel is flexible. Pick whatever their
security policy allows — you do **not** need access to their systems for any of
these:

- **Shared S3 bucket** in the joint/shared account → presigned URL (you upload to
  a bucket *you* can write; they download). Most common.
- Their **artifact store** if they expose an upload endpoint to you
  (Nexus/Artifactory/GitLab package registry).
- Secure file-transfer / managed-transfer portal their org runs.
- If attachments are blocked and nothing else is available: it's a single file —
  `base64` it and paste through an approved channel; they `base64 -d` to rebuild.

### Step 4 (CUSTOMER, not you) — import into their GitLab

Hand them these commands (they're in the install README too). The customer runs
them on *their* side; you never see their GitLab URL:

```bash
tar xzf brisa-triage-agent-<sha>.tar.gz
cd brisa-triage-agent
git init && git add -A && git commit -m "Import triage agent <sha>"
git remote add origin <their-gitlab-project-url>     # THEY supply this
git push -u origin main
```

From here it's *their* repo. They self-serve edits (`SKILL.md`, `config.yaml`),
build the image on their host, and deploy — see
[GUIDE-configure-and-change-the-prompt.md](GUIDE-configure-and-change-the-prompt.md).

### Updates later — same artifact, they merge

When you fix something upstream, repeat Steps 1–3 with the new `<sha>`. The
customer applies your update **on their side**, choosing how:

- **Simple (overwrite):** extract the new tar over a clean checkout, commit, push.
  Loses their local edits — fine if they made none.
- **Preserves their edits:** keep your drops on a `vendor`/`upstream` branch they
  merge into their `main`. Tell them up front to **branch their customizations**
  so an upstream drop merges cleanly instead of clobbering.

Because you hand over a *new versioned artifact* each time (not a live git remote
they pull from), there is no standing connection between your repo and theirs —
which is exactly the boundary you want.

---

## The other half: the customer needs the IMAGE too (or the means to build it)

Self-serve changes split into two speeds (see
[GUIDE-configure-and-change-the-prompt.md](GUIDE-configure-and-change-the-prompt.md)):

- **Fast path** (config.yaml / receiver.yaml / secrets via `kubectl`) — needs only
  the manifests, which the repo gives them. No image, no build.
- **Slow path** (SKILL.md / prompt / scripts) — needs an **image rebuild**. For
  this the customer needs `docker buildx` + push rights to their ECR, then:
  ```bash
  make agent-image AGENT=jira-triage-dc HARNESS=pi REGION=eu-west-1 AGENT_ECR_REPO=triage-agent
  ```

**Confirmed for Brisa:** the customer **can build images in-house** (their build
host has Docker + ECR push). So they are fully self-sufficient from the artifact
alone — they build the image on their side, and you never need access to their
ECR. (If a customer ever *can't* build in-house, the fallback is the managed model
— you build + push to their ECR on request — but that contradicts "self-serve
prompt changes" and doesn't apply here.)

> The `Makefile` at the repo root has lab targets (`make cluster`, `make up`) that
> reference `workshop/`. If you deliver `agent/` as the repo root, **carry only the
> `agent-image` target** (or a trimmed Makefile) so they don't see/try the lab
> bring-up. Easiest: give them a tiny `Makefile` with just `agent-image` +
> `agent-deploy`, documented in the install guide.

---

## Suggested first handoff sequence

1. **(YOU)** Commit the DC variant + docs; merge to `main`. *(Done — PR #14.)*
2. **(YOU)** Produce + verify the artifact (Steps 1–2 above) and move it across
   (Step 3). You stop here — you never touch their systems.
3. **(CUSTOMER)** Import the artifact into their GitLab (Step 4 above).
4. **(CUSTOMER, you advising)** Walk them through one **fast-path** change (add an
   allowed label via `kubectl apply`) and one **slow-path** change (edit
   `SKILL.md`, rebuild, bump the image tag) using the configure guide — so they've
   done both loops once with you on a call, but their hands on their keyboard.
5. **(BOTH)** Agree the **update cadence**: you drop a new versioned artifact on
   fixes; they decide overwrite-vs-merge and branch their customizations.

---

## What NOT to deliver (keep private)

- `workshop/` — your lab; implies you stand up their cluster (you don't).
- `docs/hld/`, `docs/decisions/`, `docs/brainstorms/`, `docs/ideation/`,
  `docs/plans/` — internal thinking.
- `.claude/`, the auto-memory — your tooling/context.
- Any filled `secrets.yaml` / `config.yaml` / `*.tfvars` — these are gitignored;
  keep it that way. The customer fills their own from the `.example` templates.
