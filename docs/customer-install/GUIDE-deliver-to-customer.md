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

## Recommended channel: push the subset into the customer's OWN GitLab

The customer already runs GitLab (in-cluster, they're admins). Delivering into a
project *there* beats both a zip and GitHub access:

- **No blocked-attachment problem** — it's a `git push`, not a file transfer.
- **Stays in their security boundary** — no external SaaS access to grant/revoke.
- **A real repo they can self-serve** — edit `SKILL.md`/`config.yaml`, rebuild,
  redeploy; and pull your future updates.
- **Your monorepo stays private** — only the `agent/` + `docs/customer-install/`
  subtree leaves.

### One-time setup — split the subset out with `git subtree`

`git subtree` extracts a subdirectory's history into a standalone branch you can
push anywhere. Do this from your monorepo:

```bash
cd <your-monorepo>

# 1. Make sure the deliverable (incl. the DC variant) is committed on main.
git status   # clean

# 2. Produce a branch whose ROOT is agent/ (history preserved for that path).
#    NOTE: subtree splits ONE prefix. We want two (agent/ + docs/customer-install/),
#    so use the archive approach below for the docs, OR keep docs under agent/.
git subtree split --prefix=agent -b deliver-agent

# 3. Add the customer's GitLab as a remote (HTTP via their URL, or SSH).
git remote add brisa-gitlab https://gitlab.brisa.internal/triage/agent.git

# 4. Push the split branch as the customer repo's main.
git push brisa-gitlab deliver-agent:main
```

> Because `subtree split` takes a single prefix, the cleanest layout is to deliver
> `agent/` as the repo root and put the customer docs *inside* it (e.g. copy
> `docs/customer-install/` to `agent/INSTALL/` before splitting), OR run two
> pushes (one subtree for `agent/`, and a plain copy of the docs). The
> **archive method below** sidesteps this by selecting both paths at once — many
> people find it simpler for the first seed.

### Pushing updates later

When you fix a prompt or a script upstream, re-split and push again:

```bash
git subtree split --prefix=agent -b deliver-agent
git push brisa-gitlab deliver-agent:main     # fast-forward; they `git pull`
```

(If they've made local commits, they merge — standard git. Tell them up front
whether they should branch their customizations to avoid conflicts.)

---

## Seed / fallback channel: a versioned archive (your option 4, done right)

Use this for the **first bootstrap** if even git access needs paperwork, or as a
belt-and-braces snapshot. `git archive` selects **multiple paths at once** (so it
beats subtree for grabbing `agent/` + `docs/customer-install/` together) and emits
a clean, versioned tree with **no `.git`, no history, no other dirs**:

```bash
cd <your-monorepo>
git archive --format=tar.gz \
  --prefix=brisa-triage-agent/ \
  -o brisa-triage-agent-$(git rev-parse --short HEAD).tar.gz \
  HEAD agent docs/customer-install
# → brisa-triage-agent-<sha>.tar.gz  (agent/ + docs/customer-install/ only)
```

Verify before sending (always look inside what you hand over):
```bash
tar tzf brisa-triage-agent-*.tar.gz | sed 's,brisa-triage-agent/,,' | sort -u | head
tar tzf brisa-triage-agent-*.tar.gz | grep -E "secrets\.yaml$|\.tfvars$|tfstate" | grep -v example \
  && echo "STOP: secret-ish file in archive" || echo "no secrets in archive ✅"
```

**If zip/tar attachments are blocked** (your worry), any of these work because the
artifact is just bytes:
- Push it to an **S3 bucket** in the shared account; share a presigned URL.
- Put it in their **artifact store** (Nexus/Artifactory/GitLab package registry).
- `scp` to a bastion they control.
- Last resort: it's a single file — even a base64 paste through an approved
  channel reconstitutes with `base64 -d`.

The git-into-their-GitLab path avoids this entirely, which is why it's the primary
recommendation.

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

Confirm with the customer that their build host has Docker + ECR push (it usually
does if they operate the cluster). If they can build, they're fully self-sufficient
with just the repo. If they *can't* build images in-house, fall back to the managed
model (you build + push to their ECR on request) — but that contradicts "self-serve
prompt changes", so settle this explicitly.

> The `Makefile` at the repo root has lab targets (`make cluster`, `make up`) that
> reference `workshop/`. If you deliver `agent/` as the repo root, **carry only the
> `agent-image` target** (or a trimmed Makefile) so they don't see/try the lab
> bring-up. Easiest: give them a tiny `Makefile` with just `agent-image` +
> `agent-deploy`, documented in the install guide.

---

## Suggested first handoff sequence

1. **Commit** the DC variant + new docs on a branch; merge to `main`.
2. **Seed** their GitLab project via `git archive` → extract → `git init` → push
   (or `git subtree push` if you can reach their GitLab directly). One time.
3. Confirm their **build host** can `docker buildx` + ECR push (Part above).
4. Walk them through one **fast-path** change (add an allowed label via
   `kubectl apply`) and one **slow-path** change (edit `SKILL.md`, rebuild, bump
   the image tag) using the configure guide — so they've done both loops once with
   you watching.
5. Agree the **update cadence**: how you push upstream fixes into their repo, and
   how they keep local customizations from conflicting (branch strategy).

---

## What NOT to deliver (keep private)

- `workshop/` — your lab; implies you stand up their cluster (you don't).
- `docs/hld/`, `docs/decisions/`, `docs/brainstorms/`, `docs/ideation/`,
  `docs/plans/` — internal thinking.
- `.claude/`, the auto-memory — your tooling/context.
- Any filled `secrets.yaml` / `config.yaml` / `*.tfvars` — these are gitignored;
  keep it that way. The customer fills their own from the `.example` templates.
