##############################################
# Bedrock access for the triage agent (IRSA)
##############################################
# The pi.dev triage agent runs headless in the cluster and calls Amazon Bedrock
# via IRSA — the pod's ServiceAccount assumes this role, so there is no static
# model credential to store or rotate (R12).
#
# The terraform-aws-modules IRSA module has no built-in Bedrock flag (unlike
# attach_ebs_csi_policy in storage.tf), so we attach a custom least-privilege
# policy via role_policy_arns. The policy is scoped to a specific model ARN —
# never "*" — so a stolen IRSA token can't invoke arbitrary (expensive) models.

variable "bedrock_model_id" {
  description = "Bedrock model ID the triage agent may invoke (e.g. a Claude inference profile). The IAM policy is scoped to exactly this model — resolve it before apply; do not widen to '*'."
  type        = string
  default     = "us.anthropic.claude-sonnet-4-20250514-v1:0"
}

variable "triage_namespace" {
  description = "Kubernetes namespace the triage agent runs in."
  type        = string
  default     = "triage"
}

variable "triage_service_account" {
  description = "ServiceAccount name the triage agent pod uses (IRSA-bound)."
  type        = string
  default     = "triage-agent"
}

variable "bedrock_vpce_lockdown" {
  description = "When true, create a bedrock-runtime VPC endpoint and restrict the Bedrock policy to calls through it (aws:SourceVpce) so an exfiltrated IRSA token can't be used from outside the VPC (R12). Leave false until the endpoint is confirmed reachable from the node group — enabling the condition without a working endpoint blocks all model calls."
  type        = bool
  default     = false
}

# Private connectivity to Bedrock so model traffic never leaves the VPC and the
# IAM policy can be locked to this endpoint. Optional (see bedrock_vpce_lockdown)
# because the condition is fail-closed: with the condition on and no reachable
# endpoint, every InvokeModel call is denied.
resource "aws_security_group" "bedrock_vpce" {
  count       = var.bedrock_vpce_lockdown ? 1 : 0
  name        = "${var.name}-bedrock-vpce"
  description = "Allow HTTPS from the VPC to the Bedrock runtime VPC endpoint."
  vpc_id      = module.vpc.vpc_id

  ingress {
    description = "HTTPS from within the VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [module.vpc.vpc_cidr_block]
  }

  tags = var.tags
}

resource "aws_vpc_endpoint" "bedrock_runtime" {
  count               = var.bedrock_vpce_lockdown ? 1 : 0
  vpc_id              = module.vpc.vpc_id
  service_name        = "com.amazonaws.${var.region}.bedrock-runtime"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = module.vpc.private_subnets
  security_group_ids  = [aws_security_group.bedrock_vpce[0].id]
  private_dns_enabled = true

  tags = var.tags
}

# Least-privilege Bedrock invoke policy, scoped to the one model the agent uses.
# Both the foundation-model ARN and the region-qualified inference-profile ARN
# are allowed because cross-region inference profiles (the `us.` prefix) invoke
# the underlying foundation model in any of the profile's regions.
data "aws_caller_identity" "current" {}

locals {
  # A cross-region inference profile id (e.g. "us.anthropic.claude-...") invokes
  # the underlying foundation model, whose id drops the leading region prefix
  # ("us.", "eu.", "apac."). Scope the foundation-model ARN to exactly that
  # model rather than "*", so the policy matches its "scoped to one model" claim.
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

    # Bound the blast radius of a stolen IRSA token: when the VPC endpoint is in
    # place, only allow invocations that traverse it (R12).
    dynamic "condition" {
      for_each = var.bedrock_vpce_lockdown ? [1] : []
      content {
        test     = "StringEquals"
        variable = "aws:SourceVpce"
        values   = [aws_vpc_endpoint.bedrock_runtime[0].id]
      }
    }
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

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["${var.triage_namespace}:${var.triage_service_account}"]
    }
  }

  tags = var.tags
}
