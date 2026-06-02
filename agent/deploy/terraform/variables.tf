##############################################
# Inputs for the customer-install agent module
##############################################
# This module provisions ONLY the cloud dependencies the triage agent needs,
# against a cluster the customer ALREADY operates. It does not create a VPC,
# cluster, or node group (contrast workshop/terraform, which builds the lab).
#
# Resolve these from the customer's existing EKS cluster before apply, e.g.:
#   aws eks describe-cluster --name <cluster> \
#     --query 'cluster.identity.oidc.issuer' --output text   # → oidc_provider_url
#   aws iam list-open-id-connect-providers                   # → oidc_provider_arn

variable "name" {
  description = "Name prefix for created IAM resources (e.g. \"acme-prod\"). Keep it unique per cluster so multiple installs don't collide."
  type        = string
}

variable "region" {
  description = "AWS region the customer's EKS cluster runs in (where Bedrock is invoked)."
  type        = string
}

variable "oidc_provider_arn" {
  description = "ARN of the EXISTING cluster's IAM OIDC provider. Required for IRSA. Get it from `aws iam list-open-id-connect-providers` (match the URL to the cluster's OIDC issuer)."
  type        = string
}

variable "bedrock_model_id" {
  description = "Bedrock model ID the agent may invoke. The IAM policy is scoped to exactly this model — never widen to '*'."
  type        = string
  default     = "us.anthropic.claude-sonnet-4-6"
}

variable "triage_namespace" {
  description = "Kubernetes namespace the agent runs in (must match agent/k8s manifests)."
  type        = string
  default     = "triage"
}

variable "triage_service_account" {
  description = "ServiceAccount name the agent pod uses (IRSA-bound; must match agent/k8s manifests)."
  type        = string
  default     = "triage-agent"
}

variable "tags" {
  description = "Tags applied to created resources."
  type        = map(string)
  default     = {}
}

##############################################
# CloudFront webhook ingress (optional)
##############################################
# Only needed when the customer wants a public HTTPS endpoint for Jira to reach
# WITHOUT buying a domain (the default *.cloudfront.net cert). If the customer
# already fronts the listener with their own ALB/Ingress + domain + TLS, leave
# this empty and skip CloudFront entirely.

variable "listener_lb_dns" {
  description = "Hostname of the agent listener's LoadBalancer (created by agent/k8s/triage-listener.yaml AFTER kubectl apply). Empty disables the CloudFront distribution; set it on a second targeted apply once the Service has an external hostname."
  type        = string
  default     = ""
}
