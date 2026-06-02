##############################################
# Bedrock access for the triage agent (IRSA)
##############################################
# The agent runs headless in the customer's cluster and calls Amazon Bedrock via
# IRSA — the pod's ServiceAccount assumes this role, so there is no static model
# credential to store or rotate (R12). This mirrors workshop/terraform/bedrock.tf
# but binds to the customer's EXISTING cluster OIDC provider (var.oidc_provider_arn)
# instead of one this module creates.
#
# The policy is scoped to a specific model ARN — never "*" — so a stolen IRSA
# token can't invoke arbitrary (expensive) models.

data "aws_caller_identity" "current" {}

locals {
  # A cross-region inference profile id (e.g. "us.anthropic.claude-...") invokes
  # the underlying foundation model, whose id drops the leading region prefix
  # ("us.", "eu.", "apac."). Scope the foundation-model ARN to exactly that model.
  bedrock_foundation_model = replace(var.bedrock_model_id, "/^(us|eu|apac)\\./", "")
}

data "aws_iam_policy_document" "bedrock_invoke" {
  statement {
    sid    = "InvokeTriageModel"
    effect = "Allow"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]
    resources = [
      "arn:aws:bedrock:*::foundation-model/${local.bedrock_foundation_model}",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/${var.bedrock_model_id}",
    ]
  }
}

resource "aws_iam_policy" "bedrock_invoke" {
  name        = "${var.name}-triage-bedrock-invoke"
  description = "Least-privilege Bedrock InvokeModel for the ${var.name} triage agent, scoped to ${var.bedrock_model_id}."
  policy      = data.aws_iam_policy_document.bedrock_invoke.json
  tags        = var.tags
}

module "triage_bedrock_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.39"

  role_name = "${var.name}-triage-bedrock"

  role_policy_arns = {
    bedrock = aws_iam_policy.bedrock_invoke.arn
  }

  # Bind to the cluster the customer ALREADY runs.
  oidc_providers = {
    main = {
      provider_arn               = var.oidc_provider_arn
      namespace_service_accounts = ["${var.triage_namespace}:${var.triage_service_account}"]
    }
  }

  tags = var.tags
}
