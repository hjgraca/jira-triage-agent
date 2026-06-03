#!/usr/bin/env bash
# Live end-to-end test of the deployed Jira triage agent.
#
# Drives the REAL ingress chain that Jira uses — CloudFront → NLB → receiver →
# Kubernetes Job → run.js → harness — and asserts each link. Two modes:
#
#   ./e2e.sh            run all stages, stop on first failure
#   ./e2e.sh --step     interactive walk-through: explain + pause before each
#                       stage so you can watch what happens at each link
#
# It is READ-MOSTLY against the cluster/Jira: the only writes are (a) POSTing
# synthetic webhooks to the receiver (which spawn run Jobs against the issue in
# $E2E_ISSUE_KEY — point this at a THROWAWAY test ticket) and (b) deleting the
# Jobs it created during cleanup. It never edits the manifests or terraform.
#
# What it proves, stage by stage:
#   1  Receiver health through CloudFront (CF → NLB → receiver path is up)
#   2  Origin lock: a direct hit to the NLB (bypassing CloudFront) is refused
#   3  Auth: an unsigned/badly-signed webhook is rejected 401
#   4  Eligibility gate: an ineligible event is dropped (200, no Job)
#   5  Spawn: a valid signed event creates exactly one run Job
#   6  Dedupe: re-sending the same delivery id creates NO second Job (409)
#   7  Concurrency quota uses the first-class `pods` key (non-terminal only)
#   8  The run Job completes and triages the ticket (audit comment posted)
#
# Config via env (all have sensible defaults / are auto-discovered):
#   NS                 k8s namespace            (default: agents)
#   WEBHOOK_URL        CloudFront webhook URL    (default: terraform output)
#   TF_DIR             terraform dir for outputs (default: workshop/terraform)
#   E2E_ISSUE_KEY      throwaway Jira issue key  (default: KAN-2)
#   E2E_ACTOR_ID       an AUTHORIZED_ACTORS id   (default: from receiver env)
#   WAIT_RUN           seconds to await the run  (default: 300; 0 = don't wait)
set -uo pipefail

# --- knobs -------------------------------------------------------------------
NS="${NS:-agents}"
TF_DIR="${TF_DIR:-workshop/terraform}"
E2E_ISSUE_KEY="${E2E_ISSUE_KEY:-KAN-2}"
WAIT_RUN="${WAIT_RUN:-300}"
STEP=0
[ "${1:-}" = "--step" ] && STEP=1

# --- pretty ------------------------------------------------------------------
if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; C=$'\e[36m'; Z=$'\e[0m'; else B=; G=; R=; Y=; C=; Z=; fi
PASS=0; FAIL=0
hr()      { printf '%s\n' "────────────────────────────────────────────────────────"; }
say()     { printf '%s\n' "$*"; }
ok()      { PASS=$((PASS+1)); printf '%s  ✔ %s%s\n' "$G" "$*" "$Z"; }
bad()     { FAIL=$((FAIL+1)); printf '%s  x %s%s\n' "$R" "$*" "$Z"; }
summary() { hr; if [ "$FAIL" -eq 0 ]; then printf '%sPASS — %d checks%s\n' "$G" "$PASS" "$Z"; else printf '%s%d passed, %d FAILED%s\n' "$R" "$PASS" "$FAIL" "$Z"; fi; }
die()     { printf '\n%sFATAL: %s%s\n' "$R" "$*" "$Z"; exit 1; }
# Stage header. In --step mode, explain the stage and wait for Enter first.
stage() {
  local n="$1" title="$2" why="$3"
  hr; printf '%sStage %s — %s%s\n' "$B" "$n" "$title" "$Z"
  if [ "$STEP" = 1 ]; then
    printf '%s%s%s\n' "$C" "$why" "$Z"
    printf '%s' "    ↵ Enter to run this stage (q to quit) … "
    read -r ans </dev/tty || true
    [ "$ans" = q ] && { say "aborted."; exit 0; }
  fi
}

need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }
need kubectl; need curl; need openssl; need jq

# --- discover the webhook URL + secrets --------------------------------------
# WEBHOOK_URL: prefer env, else terraform output, else fail with guidance.
if [ -z "${WEBHOOK_URL:-}" ]; then
  WEBHOOK_URL="$(terraform -chdir="$TF_DIR" output -raw triage_webhook_url 2>/dev/null || true)"
fi
[ -n "$WEBHOOK_URL" ] || die "no WEBHOOK_URL (set it, or run from a tree where '$TF_DIR' has the triage_webhook_url output). Is CloudFront wired to the NLB yet?"
BASE_URL="${WEBHOOK_URL%/*}"   # strip the /jira-webhook path → scheme://host

# Pull the auth secrets + an authorized actor straight from the cluster so the
# signed requests are valid against the live deployment (read-only).
sec() { kubectl -n "$NS" get secret agent-secrets -o "jsonpath={.data.$1}" 2>/dev/null | base64 -d 2>/dev/null; }
HMAC="$(sec webhook-hmac-secret)"
SHARED="$(sec automation-shared-secret)"
if [ -z "${E2E_ACTOR_ID:-}" ]; then
  E2E_ACTOR_ID="$(kubectl -n "$NS" get deploy agent-receiver \
    -o jsonpath='{range .spec.template.spec.containers[0].env[?(@.name=="AUTHORIZED_ACTORS")]}{.value}{end}' 2>/dev/null | cut -d, -f1)"
fi
[ -n "$HMAC$SHARED" ] || die "no auth secret found in $NS/agent-secrets (need webhook-hmac-secret or automation-shared-secret)"

# Deterministic Job name = sha256(deliveryId)[:16], prefixed by the agent name —
# this MUST match runtime/lib/job.js, and IS the dedupe key.
jobname() { printf 'jira-triage-%s' "$(printf '%s' "$1" | openssl dgst -sha256 | awk '{print substr($NF,1,16)}')"; }
jobs_count() { kubectl -n "$NS" get jobs --no-headers 2>/dev/null | wc -l | tr -d ' '; }
# Single HTTP-status token. On timeout/refusal curl's -w still yields 000.
hcode() { local c; c=$(curl -sS -m "${2:-20}" -o /dev/null -w '%{http_code}' "$1" 2>/dev/null); printf '%s' "${c:-000}"; }

say "${B}Jira triage agent — live end-to-end test${Z}"
say "  webhook URL : $WEBHOOK_URL"
say "  namespace   : $NS"
say "  test issue  : $E2E_ISSUE_KEY   (writes go here — use a throwaway ticket)"
say "  actor id    : ${E2E_ACTOR_ID:-<none found>}"
say "  auth        : HMAC=$([ -n "$HMAC" ] && echo yes || echo no)  shared-secret=$([ -n "$SHARED" ] && echo yes || echo no)"
[ "$STEP" = 1 ] && say "  mode        : ${Y}step-by-step${Z}"

# =============================================================================
stage 1 "Receiver health through CloudFront" \
"Hits GET /healthz and /readyz on the public CloudFront URL. A 200 proves the
whole front path is live: CloudFront → the LBC-managed NLB → a receiver pod.
(These endpoints need no auth — the receiver is stateless, ready when up.)"
h1=$(hcode "$BASE_URL/healthz"); h2=$(hcode "$BASE_URL/readyz")
say "    GET /healthz → $h1    GET /readyz → $h2"
[ "$h1" = 200 ] && [ "$h2" = 200 ] && ok "receiver reachable through CloudFront" \
  || bad "expected 200/200 through CloudFront, got $h1/$h2 (CloudFront deployed? NLB healthy?)"

# =============================================================================
stage 2 "Origin lock — direct NLB hit must be refused" \
"The NLB's security group allows inbound ONLY from CloudFront's managed prefix
list (one rule). So hitting the NLB hostname directly, bypassing CloudFront,
must hang/refuse. If THIS succeeds, the origin lock is open — a finding."
NLB_DNS="$(kubectl -n "$NS" get svc agent-receiver -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null)"
if [ -z "$NLB_DNS" ]; then
  say "    ${Y}skip${Z}: receiver Service has no LB hostname yet"
else
  say "    direct: http://$NLB_DNS/healthz  (expect timeout/refused)"
  dc=$(hcode "http://$NLB_DNS/healthz" 8)
  if [ "$dc" = 000 ]; then ok "direct-to-NLB refused (origin lock holds; only CloudFront allowed)"
  else bad "direct NLB hit returned HTTP $dc — origin lock is NOT restricting to CloudFront"; fi
fi

# =============================================================================
stage 3 "Auth — unsigned webhook rejected 401" \
"POSTs a webhook with a bogus signature. The receiver authenticates BEFORE
parsing or gating, so a bad signature must be a hard 401 and create no Job."
ac=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -X POST "$WEBHOOK_URL" \
  -H 'Content-Type: application/json' \
  -H 'X-Hub-Signature: sha256=deadbeef' \
  -H "X-Atlassian-Webhook-Identifier: e2e-badauth-$$" \
  --data '{"webhookEvent":"jira:issue_created","issue":{"key":"'"$E2E_ISSUE_KEY"'"}}' 2>/dev/null || echo 000)
say "    POST (bad signature) → HTTP $ac"
[ "$ac" = 401 ] && ok "unauthenticated webhook rejected (401)" || bad "expected 401, got $ac"

# =============================================================================
stage 4 "Eligibility gate — ineligible event dropped" \
"Sends a VALID, authenticated event that is not eligible (an issue_updated with
no triage-label-add in the changelog). The receiver acks 200 but must DROP it
(log 'ineligible event') and create no Job. We assert the Job count is flat."
before4=$(jobs_count)
body4='{"webhookEvent":"jira:issue_updated","issue":{"key":"'"$E2E_ISSUE_KEY"'"},"user":{"accountId":"'"${E2E_ACTOR_ID:-x}"'"}}'
if [ -n "$HMAC" ]; then
  sig="sha256=$(printf '%s' "$body4" | openssl dgst -sha256 -hmac "$HMAC" | awk '{print $NF}')"
  authflag=(-H "X-Hub-Signature: $sig")
else
  authflag=(-H "X-Triage-Token: $SHARED")
fi
gc=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -X POST "$WEBHOOK_URL" \
  -H 'Content-Type: application/json' "${authflag[@]}" \
  -H "X-Atlassian-Webhook-Identifier: e2e-ineligible-$$" --data "$body4" 2>/dev/null || echo 000)
sleep 2; after4=$(jobs_count)
say "    POST (ineligible) → HTTP $gc    jobs: $before4 → $after4"
{ [ "$gc" = 200 ] && [ "$after4" = "$before4" ]; } \
  && ok "ineligible event acked 200 and dropped (no Job)" \
  || bad "expected 200 + no new Job, got HTTP $gc and jobs $before4→$after4"

# =============================================================================
stage 5 "Spawn — valid event creates one run Job" \
"Sends exactly what the real Jira Automation rule POSTs: the synthetic
'automation:label-added' event for an authorized actor, with the shared-secret
bearer (or HMAC). The receiver must gate it through and create ONE Job, named
deterministically from the delivery id. We assert that exact Job appears."
DELIV="e2e-spawn-$$-$(jobs_count)"
EXPECT_JOB="$(jobname "$DELIV")"
body5='{"webhookEvent":"automation:label-added","issue":{"key":"'"$E2E_ISSUE_KEY"'"},"user":{"accountId":"'"${E2E_ACTOR_ID:-x}"'"}}'
# automation:label-added is the Automation-rule path → shared-secret bearer.
if [ -n "$SHARED" ]; then sp_auth=(-H "X-Triage-Token: $SHARED"); else
  sig5="sha256=$(printf '%s' "$body5" | openssl dgst -sha256 -hmac "$HMAC" | awk '{print $NF}')"; sp_auth=(-H "X-Hub-Signature: $sig5"); fi
say "    POST automation:label-added  delivery=$DELIV"
say "    expecting Job: $EXPECT_JOB"
sc=$(curl -sS -m 25 -o /dev/null -w '%{http_code}' -X POST "$WEBHOOK_URL" \
  -H 'Content-Type: application/json' "${sp_auth[@]}" \
  -H "X-Triage-Delivery-Id: $DELIV" --data "$body5" 2>/dev/null || echo 000)
sleep 3
if [ "$sc" = 200 ] && kubectl -n "$NS" get job "$EXPECT_JOB" >/dev/null 2>&1; then
  ok "valid event spawned the run Job ($EXPECT_JOB)"
  kubectl -n "$NS" get job "$EXPECT_JOB" 2>&1 | sed 's/^/      /'
else
  bad "expected 200 + Job $EXPECT_JOB; got HTTP $sc (see: kubectl -n $NS get jobs)"
fi

# =============================================================================
stage 6 "Dedupe — re-send same delivery id, no second Job" \
"Re-POSTs the IDENTICAL delivery id from stage 5. The Job name is derived from
that id, so the second create hits a 409 AlreadyExists — the receiver logs
'duplicate' and acks 200. We assert the namespace Job count did NOT grow."
before6=$(jobs_count)
dc6=$(curl -sS -m 25 -o /dev/null -w '%{http_code}' -X POST "$WEBHOOK_URL" \
  -H 'Content-Type: application/json' "${sp_auth[@]}" \
  -H "X-Triage-Delivery-Id: $DELIV" --data "$body5" 2>/dev/null || echo 000)
sleep 2; after6=$(jobs_count)
say "    POST (same delivery id) → HTTP $dc6    jobs: $before6 → $after6"
{ [ "$dc6" = 200 ] && [ "$after6" = "$before6" ]; } \
  && ok "duplicate delivery deduped (no second Job)" \
  || bad "expected 200 + flat Job count, got HTTP $dc6 and $before6→$after6"

# =============================================================================
stage 7 "Concurrency quota uses the non-terminal pods key" \
"The ResourceQuota must use the first-class 'pods' key (counts Pending/Running
only), NOT 'count/pods' (which also counts finished pods and would wedge the cap
shut for an hour). We read the live quota spec and confirm which key is set."
qkeys="$(kubectl -n "$NS" get resourcequota -o jsonpath='{range .items[*]}{.spec.hard}{"\n"}{end}' 2>/dev/null)"
say "    quota hard spec: ${qkeys:-<none>}"
if printf '%s' "$qkeys" | grep -q '"pods"'; then
  ok "quota uses non-terminal 'pods' key (finished runs free their slot)"
elif printf '%s' "$qkeys" | grep -q 'count/pods'; then
  bad "quota uses 'count/pods' — finished run pods will wedge the cap (see resourcequota.yaml fix)"
else
  say "    ${Y}note${Z}: no ResourceQuota found in $NS (concurrency cap not enforced)"
fi

# =============================================================================
stage 8 "Run completes and triages the ticket" \
"Waits for the stage-5 Job to finish and shows the run's verdict tail (it posts
an audit comment to the real Jira issue). Set WAIT_RUN=0 to skip the wait."
if [ "$WAIT_RUN" = 0 ]; then
  say "    ${Y}skip${Z}: WAIT_RUN=0 (Job '$EXPECT_JOB' left running)"
elif kubectl -n "$NS" get job "$EXPECT_JOB" >/dev/null 2>&1; then
  say "    waiting up to ${WAIT_RUN}s for $EXPECT_JOB to complete …"
  if kubectl -n "$NS" wait --for=condition=complete "job/$EXPECT_JOB" --timeout="${WAIT_RUN}s" >/dev/null 2>&1; then
    ok "run Job completed"
    say "    ${C}verdict tail:${Z}"
    kubectl -n "$NS" logs "job/$EXPECT_JOB" --tail=200 2>/dev/null \
      | grep -oE '"text":"[^"]*(category|triaged|Summary|✅)[^"]*"' | tail -3 | sed 's/^/      /' \
      || kubectl -n "$NS" logs "job/$EXPECT_JOB" --tail=5 2>/dev/null | sed 's/^/      /'
  else
    bad "run Job did not complete within ${WAIT_RUN}s (kubectl -n $NS logs job/$EXPECT_JOB)"
  fi
else
  say "    ${Y}skip${Z}: stage-5 Job not present"
fi

# --- cleanup -----------------------------------------------------------------
# Remove the run Job this test created so it doesn't linger / occupy quota.
if [ -n "${EXPECT_JOB:-}" ] && kubectl -n "$NS" get job "$EXPECT_JOB" >/dev/null 2>&1; then
  hr
  if [ "$STEP" = 1 ]; then
    printf '%s' "Delete the test Job $EXPECT_JOB? [Y/n] "; read -r d </dev/tty || true
    [ "${d:-y}" = n ] || kubectl -n "$NS" delete job "$EXPECT_JOB" >/dev/null 2>&1 && say "cleaned up $EXPECT_JOB"
  else
    kubectl -n "$NS" delete job "$EXPECT_JOB" >/dev/null 2>&1 && say "cleaned up test Job $EXPECT_JOB"
  fi
fi

summary
[ "$FAIL" -eq 0 ]
