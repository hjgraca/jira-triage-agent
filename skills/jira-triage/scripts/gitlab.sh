#!/usr/bin/env bash
# gitlab.sh — read-only GitLab lookups for routing, via the REST API.
#
# SECURITY (R2a/R2b): this script returns ONLY a bounded, structured object —
# {"component": "...", "owner": "..."} — extracted from named API fields. It
# never emits raw repository file content into stdout, so attacker-controlled
# repo text (a malicious CODEOWNERS/README) cannot enter the agent's context or
# be echoed into a Jira comment. Routing hints in, no file bodies out.
#
# Reads GITLAB_BASE_URL (e.g. http://gitlab-webservice-default.gitlab.svc) and
# GITLAB_READ_TOKEN (minimum-privilege deploy token, read_repository) from env.
set -euo pipefail

: "${GITLAB_BASE_URL:?GITLAB_BASE_URL is required (in-cluster Service DNS)}"
: "${GITLAB_READ_TOKEN:?GITLAB_READ_TOKEN is required}"

_die() { echo "gitlab.sh: $*" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || _die "jq is required"

_api() {
  # _api PATH — GET against the GitLab v4 API, returns raw JSON on stdout.
  local path="$1"
  curl -sS "${GITLAB_BASE_URL%/}/api/v4${path}" \
    -H "PRIVATE-TOKEN: ${GITLAB_READ_TOKEN}" \
    -H "Accept: application/json" \
    --fail-with-body
}

# route PROJECT_ID_OR_PATH [PATH_HINT]
# Resolves an owning component + owner for a problem area. Strategy:
#   1. Look up the project's CODEOWNERS-derived owner if the API exposes it,
#      else fall back to the project's namespace/maintainer.
#   2. Emit ONLY {component, owner} — never the matched file's contents.
# PATH_HINT (optional) narrows to a subdirectory/component when provided.
cmd_route() {
  local project="${1:?usage: route PROJECT_ID_OR_PATH [PATH_HINT]}"
  local hint="${2:-}"
  # URL-encode the project path (GitLab expects %2F for slashes).
  local enc; enc="$(printf '%s' "$project" | jq -sRr @uri)"

  # Project metadata — extract only name + namespace path, discard everything else.
  local proj; proj="$(_api "/projects/${enc}")" || _die "project lookup failed for '$project'"
  local component owner
  component="$(printf '%s' "$proj" | jq -r '.name // empty')"
  # Owner heuristic: namespace full path (team/group) is a stable routing target
  # that does not leak file content. A CODEOWNERS-based refinement can be added
  # once confirmed against the live repo; until then this is the safe default.
  owner="$(printf '%s' "$proj" | jq -r '(.namespace.full_path) // empty')"

  [ -n "$hint" ] && component="${component}/${hint}"
  [ -n "$component" ] || _die "could not resolve component for '$project'"

  # Bounded structured output — the ONLY thing the agent ever sees from GitLab.
  jq -n --arg c "$component" --arg o "$owner" '{component: $c, owner: $o}'
}

main() {
  local sub="${1:?usage: gitlab.sh route PROJECT_ID_OR_PATH [PATH_HINT]}"
  shift || true
  case "$sub" in
    route) cmd_route "$@" ;;
    *) _die "unknown subcommand '$sub'" ;;
  esac
}

main "$@"
