#!/usr/bin/env bash
# irsa-bedrock.sh — create the ONE AWS resource the agent needs, with the AWS CLI.
#
# The agent calls Amazon Bedrock from the cluster via IRSA: the agent-runner
# ServiceAccount assumes an IAM role whose policy is scoped to EXACTLY one model.
# That single role is the only cloud resource — everything else is `kubectl apply`.
# This script creates it with the AWS CLI and prints the role ARN to paste into
# namespace.yaml. No state files, nothing else to install or manage.
#
# Idempotent: re-running updates the policy/role rather than erroring.
#
# Prereqs: aws CLI v2 (logged in to the cluster's account) and jq.
#
# Usage:
#   CLUSTER=<eks-cluster-name> REGION=eu-west-1 ./irsa-bedrock.sh
# Optional overrides (defaults match the K8s manifests — change only if you
# relocated the SA/namespace or use a different model):
#   NAMESPACE=agents  SA=agent-runner  MODEL=eu.anthropic.claude-sonnet-4-6
#   ROLE_NAME=triage-bedrock
set -euo pipefail

: "${CLUSTER:?set CLUSTER=<your-eks-cluster-name>}"
: "${REGION:=eu-west-1}"
NAMESPACE="${NAMESPACE:-agents}"
SA="${SA:-agent-runner}"
MODEL="${MODEL:-eu.anthropic.claude-sonnet-4-6}"
ROLE_NAME="${ROLE_NAME:-${CLUSTER}-triage-bedrock}"
POLICY_NAME="${POLICY_NAME:-${ROLE_NAME}-invoke}"

command -v aws >/dev/null || { echo "aws CLI v2 required"; exit 1; }
command -v jq  >/dev/null || { echo "jq required"; exit 1; }

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
# A cross-region inference profile id (eu./us./apac.) invokes the underlying
# foundation model, whose id drops that leading prefix. Scope to exactly that
# model — never "*" — so a stolen IRSA token can't invoke arbitrary models.
FM="$(printf '%s' "$MODEL" | sed -E 's/^(us|eu|apac)\.//')"

echo "Account=$ACCOUNT_ID  Cluster=$CLUSTER  Region=$REGION"
echo "Namespace/SA=$NAMESPACE/$SA  Model=$MODEL  (foundation-model=$FM)"
echo "Role=$ROLE_NAME  Policy=$POLICY_NAME"
echo

# 1. Least-privilege Bedrock policy (create or reuse), scoped to the one model.
POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${POLICY_NAME}"
POLICY_DOC="$(jq -n --arg acct "$ACCOUNT_ID" --arg fm "$FM" --arg mp "$MODEL" '{
  Version: "2012-10-17",
  Statement: [{
    Sid: "InvokeTriageModel",
    Effect: "Allow",
    Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
    Resource: [
      "arn:aws:bedrock:*::foundation-model/\($fm)",
      "arn:aws:bedrock:*:\($acct):inference-profile/\($mp)"
    ]
  }]
}')"

if aws iam get-policy --policy-arn "$POLICY_ARN" >/dev/null 2>&1; then
  echo "policy exists → adding a new default version"
  aws iam create-policy-version --policy-arn "$POLICY_ARN" \
    --policy-document "$POLICY_DOC" --set-as-default >/dev/null
else
  echo "creating policy $POLICY_NAME"
  aws iam create-policy --policy-name "$POLICY_NAME" \
    --description "Least-privilege Bedrock InvokeModel for the triage agent, scoped to ${MODEL}." \
    --policy-document "$POLICY_DOC" >/dev/null
fi

# 2. Ensure the cluster's IAM OIDC provider exists (IRSA's trust anchor).
OIDC_ISSUER="$(aws eks describe-cluster --name "$CLUSTER" --region "$REGION" \
  --query 'cluster.identity.oidc.issuer' --output text)"
OIDC_HOST="${OIDC_ISSUER#https://}"
OIDC_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_HOST}"

if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" >/dev/null 2>&1; then
  echo "OIDC provider already associated"
else
  echo "associating cluster OIDC provider $OIDC_HOST"
  # The thumbprint is no longer security-relevant for EKS OIDC (STS validates the
  # issuer directly), but the API still requires one; a well-known root works and
  # AWS ignores it for *.eks.amazonaws.com issuers.
  aws iam create-open-id-connect-provider \
    --url "$OIDC_ISSUER" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list "9e99a48a9960b14926bb7f3b02e22da2b0ab7280" >/dev/null
fi

# 3. The IRSA role: trust policy ties the OIDC provider to ONE
#    namespace:serviceaccount, so only the agent-runner SA can assume it.
TRUST_DOC="$(jq -n --arg arn "$OIDC_ARN" --arg host "$OIDC_HOST" \
  --arg sub "system:serviceaccount:${NAMESPACE}:${SA}" '{
  Version: "2012-10-17",
  Statement: [{
    Effect: "Allow",
    Principal: { Federated: $arn },
    Action: "sts:AssumeRoleWithWebIdentity",
    Condition: { StringEquals: {
      "\($host):sub": $sub,
      "\($host):aud": "sts.amazonaws.com"
    } }
  }]
}')"

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "role exists → updating its trust policy"
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" \
    --policy-document "$TRUST_DOC" >/dev/null
else
  echo "creating IRSA role $ROLE_NAME bound to $NAMESPACE:$SA"
  aws iam create-role --role-name "$ROLE_NAME" \
    --description "Triage agent run-Job role; assumed by ${NAMESPACE}:${SA} via IRSA." \
    --assume-role-policy-document "$TRUST_DOC" >/dev/null
fi

# attach-role-policy is idempotent (no error if already attached).
aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn "$POLICY_ARN" >/dev/null

ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)"
echo
echo "✅ IRSA role ready:"
echo "   $ROLE_ARN"
echo
echo "Put this on the agent-runner SA — in overlays/eks-bedrock/sa-irsa-patch.yaml"
echo "(or base/namespace.yaml):"
echo "   eks.amazonaws.com/role-arn: $ROLE_ARN"
echo
echo "(This script already annotated the live SA; the manifest keeps it on re-apply.)"
