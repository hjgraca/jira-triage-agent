#!/usr/bin/env bash
# irsa-bedrock.sh — create the ONE AWS thing the agent needs, without Terraform.
#
# The agent calls Amazon Bedrock from the cluster via IRSA: the agent-runner
# ServiceAccount assumes an IAM role whose policy is scoped to EXACTLY one model.
# That single role is the only cloud resource — everything else is `kubectl apply`.
# This script creates it with eksctl (EKS-native) and prints the role ARN to paste
# into namespace.yaml. No state files, no providers, no terraform.
#
# Idempotent: re-running updates the SA/role rather than erroring.
#
# Prereqs: aws CLI v2 (logged in to the cluster's account), eksctl, jq, kubectl.
# If you don't have eksctl, see the "Raw AWS CLI fallback" at the bottom — same
# result with `aws iam` calls only.
#
# Usage:
#   CLUSTER=<eks-cluster-name> REGION=eu-west-1 ./irsa-bedrock.sh
# Optional overrides (defaults match the K8s manifests — change only if you
# relocated the SA/namespace or use a different model):
#   NAMESPACE=agents  SA=agent-runner  MODEL=eu.anthropic.claude-sonnet-4-6
#   ROLE_NAME=brisa-triage-bedrock
set -euo pipefail

: "${CLUSTER:?set CLUSTER=<your-eks-cluster-name>}"
: "${REGION:=eu-west-1}"
NAMESPACE="${NAMESPACE:-agents}"
SA="${SA:-agent-runner}"
MODEL="${MODEL:-eu.anthropic.claude-sonnet-4-6}"
ROLE_NAME="${ROLE_NAME:-${CLUSTER}-triage-bedrock}"
POLICY_NAME="${POLICY_NAME:-${ROLE_NAME}-invoke}"

command -v aws    >/dev/null || { echo "aws CLI v2 required"; exit 1; }
command -v jq     >/dev/null || { echo "jq required"; exit 1; }

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

# 2. The IRSA role + SA annotation, via eksctl (creates/associates the OIDC trust
#    for namespace:serviceaccount and annotates the SA in-cluster).
if command -v eksctl >/dev/null; then
  echo "ensuring cluster OIDC provider is associated…"
  eksctl utils associate-iam-oidc-provider --cluster "$CLUSTER" --region "$REGION" --approve >/dev/null 2>&1 || true

  echo "creating IRSA role $ROLE_NAME bound to $NAMESPACE:$SA…"
  # --override-existing-serviceaccounts: annotate the SA even though namespace.yaml
  # already declares it. --role-only keeps eksctl from owning the SA object; we let
  # the manifests own it and just need the role+annotation.
  eksctl create iamserviceaccount \
    --cluster "$CLUSTER" --region "$REGION" \
    --namespace "$NAMESPACE" --name "$SA" \
    --role-name "$ROLE_NAME" \
    --attach-policy-arn "$POLICY_ARN" \
    --override-existing-serviceaccounts \
    --approve

  ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)"
  echo
  echo "✅ IRSA role ready:"
  echo "   $ROLE_ARN"
  echo
  echo "Put this in agent/deploy/k8s/namespace.yaml on the agent-runner SA:"
  echo "   eks.amazonaws.com/role-arn: $ROLE_ARN"
  echo
  echo "(eksctl already annotated the live SA; the manifest line keeps it correct"
  echo " on re-apply. Apply namespace.yaml AFTER this so the annotation persists.)"
else
  cat <<EOF
eksctl not found. Either install it, or run the raw AWS CLI fallback:

  OIDC=\$(aws eks describe-cluster --name "$CLUSTER" --region "$REGION" \\
    --query 'cluster.identity.oidc.issuer' --output text | sed 's,https://,,')

  TRUST=\$(cat <<JSON
  { "Version":"2012-10-17","Statement":[{
    "Effect":"Allow",
    "Principal":{"Federated":"arn:aws:iam::${ACCOUNT_ID}:oidc-provider/\$OIDC"},
    "Action":"sts:AssumeRoleWithWebIdentity",
    "Condition":{"StringEquals":{
      "\$OIDC:sub":"system:serviceaccount:${NAMESPACE}:${SA}",
      "\$OIDC:aud":"sts.amazonaws.com"}}}]}
  JSON
  )
  aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "\$TRUST"
  aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn "$POLICY_ARN"
  aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text
  # → paste that ARN into namespace.yaml (agent-runner SA annotation)
  # NOTE: requires the cluster OIDC provider to already exist
  #   (aws iam list-open-id-connect-providers).
EOF
  exit 0
fi
