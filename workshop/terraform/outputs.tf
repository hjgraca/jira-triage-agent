output "cluster_name" {
  description = "EKS cluster name."
  value       = module.eks.cluster_name
}

output "region" {
  description = "AWS region the cluster runs in."
  value       = var.region
}

output "cluster_endpoint" {
  description = "EKS API server endpoint."
  value       = module.eks.cluster_endpoint
}

output "configure_kubectl" {
  description = "Command to update your local kubeconfig for this cluster."
  value       = "aws eks update-kubeconfig --region ${var.region} --name ${module.eks.cluster_name}"
}

output "triage_bedrock_role_arn" {
  description = "IAM role ARN for the triage agent's IRSA binding. Annotate the triage-agent ServiceAccount with this (eks.amazonaws.com/role-arn)."
  value       = module.triage_bedrock_irsa.iam_role_arn
}
