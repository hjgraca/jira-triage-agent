# 02 — Configure GitLab

The agent reads GitLab **read-only** to route tickets to the right component and,
for feature tickets, to analyze which repos a change touches and how to split the
work across teams. It never writes to GitLab.

← [Prerequisites](01-prerequisites.md) · Next → [Configure Jira](03-configure-jira.md)

---

## 1. Create a minimum-privilege read token

Prefer a **project (or group) deploy token** with only `read_repository`. Add
`read_api` **only** if you want richer routing (project metadata lookups); the
bundled scripts work with `read_repository` plus `read_api` for the
`list-repos`/`route` calls.

GitLab → **Project (or Group) → Settings → Repository → Deploy tokens**:

- **Scopes:** `read_repository` (+ `read_api` if using `route`/`list-repos`)
- Copy the generated token — it goes into the Kubernetes secret as
  `gitlab-read-token`.

> Do **not** use a full personal access token. The agent runs an LLM over
> untrusted ticket text with a shell tool; the blast radius of a leaked token
> must be "read these repos", nothing more.

## 2. Make GitLab reachable from the cluster

Set `GITLAB_BASE_URL` (in `agent/k8s/triage-listener.yaml`) to a URL the pod can
reach:

- **In-cluster GitLab:** use the Service DNS, including the port. In the workshop
  that is `http://gitlab-webservice-default.gitlab.svc:8080` (the service has no
  port-80 listener — the `:8080` matters).
- **External GitLab:** use the HTTPS URL, and ensure the egress NetworkPolicy
  (if enforced) allows it. The bundled policy allows in-cluster ranges + HTTPS on
  443; widen/narrow as needed.

Quick reachability check from inside the cluster:

```bash
kubectl -n triage run gl-probe --rm -it --restart=Never --image=curlimages/curl -- \
  curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "PRIVATE-TOKEN: <token>" "<GITLAB_BASE_URL>/api/v4/projects?per_page=1"
# expect 200
```

## 3. Add CODEOWNERS for routing (recommended)

The agent maps a touched path → owning team using each repo's **CODEOWNERS**
file. Without it, the agent can still classify and comment, but it will decline
to assign and will route less precisely.

A minimal example (`CODEOWNERS` at repo root):

```
# Frontend
/src/checkout/      @storefront-team @platform-team
/src/               @storefront-team

# Backend
/routes/orders.js   @platform-team @payments-team
/routes/catalog.js  @catalog-team
/                   @platform-team
```

The agent reads CODEOWNERS via the read token; no extra setup beyond the file
existing in the default branch.

## 4. What the agent can read (and the bounds)

The `gitlab.sh` script (bundled in the image) exposes only these read-only verbs,
each bounded so a single run can't pull an unbounded repo into the model context:

| Verb | Returns | Bound |
|---|---|---|
| `route` | `{component, owner}` only — no file bodies | — |
| `list-repos` | visible projects (id/path/name/description) | 100 |
| `tree` | recursive path listing | `MAX_TREE_ENTRIES` (200) |
| `read` | one file's content | `MAX_READ_BYTES` (16 KB), truncated flag |
| `codeowners` | parsed `{pattern, owners}` rules | — |

Repo code **informs the agent's reasoning** but, per the skill rubric (R2a), is
**never** pasted into a Jira comment. See [Security](06-security.md).

Next → [Configure Jira](03-configure-jira.md)
