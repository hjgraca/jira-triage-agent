output "triage_bedrock_role_arn" {
  description = "IAM role ARN for the agent's IRSA binding. Annotate the triage-agent ServiceAccount with this (eks.amazonaws.com/role-arn in agent/k8s/triage-namespace.yaml)."
  value       = module.triage_bedrock_irsa.iam_role_arn
}

output "triage_webhook_url" {
  description = "Public webhook URL to register in Jira. Empty until listener_lb_dns is set (CloudFront disabled)."
  value       = local.cf_enabled ? "https://${aws_cloudfront_distribution.agent[0].domain_name}/jira-webhook" : ""
}

output "cloudfront_origin_cidrs" {
  description = "CloudFront origin-facing CIDRs (legacy classic-ELB / own-ALB paths only — these ~45 CIDRs overflow the 60-rules-per-SG limit on a classic ELB; prefer the prefix-list id below with the NLB). Empty when CloudFront is disabled."
  value       = local.cf_enabled ? data.aws_ec2_managed_prefix_list.cloudfront_origin_facing[0].entries[*].cidr : []
}

output "cloudfront_origin_prefix_list_id" {
  description = "CloudFront origin-facing managed prefix-list id for this region. Set it in the receiver Service's aws-load-balancer-security-group-prefix-lists annotation to lock the NLB to CloudFront with ONE SG rule (R10b)."
  value       = data.aws_ec2_managed_prefix_list.cloudfront_origin_facing_id.id
}
