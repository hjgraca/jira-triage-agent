##############################################
# Cluster-admin access for a teammate (EKS only, no account access)
##############################################
# Goal: let a teammate run kubectl as cluster-admin on the workshop cluster
# WITHOUT any AWS account privileges. The split is deliberate:
#
#   * AWS layer  — the IAM role "eks-cluster-admin" can do almost nothing. Its
#     only permission is eks:DescribeCluster/ListClusters (the eks-describe-only
#     managed policy), which `aws eks update-kubeconfig` needs. It cannot touch
#     Bedrock, IAM, EC2, S3, or disable any safeguard.
#   * Kube layer — the EKS access entry (in main.tf) maps the role to the
#     managed AmazonEKSClusterAdminPolicy, scoped to THIS cluster only.
#
# This works because an EKS auth token is just a pre-signed STS
# GetCallerIdentity call: authentication is IAM, but authorization lives entirely
# in the cluster access entry. So a near-powerless IAM role can still be
# cluster-admin in-cluster, and nowhere else.
#
# OWNERSHIP: the "eks-cluster-admin" IAM role is created and owned by ISENGARD
# (via `isengardcli add-role ... --posix-group <alias> --role-policy <eks-describe-only>`),
# not Terraform — Isengard can only federate teammates into roles it manages.
# Terraform just reads the role below and wires the cluster access entry to it.
#
# Teammate access:
#   isengardcli creds 746792595426 --role eks-cluster-admin
#   aws eks update-kubeconfig --name workshop --region us-west-2

variable "create_eks_cluster_admin_role" {
  description = "Wire the Isengard-owned eks-cluster-admin role to a cluster-admin access entry. The IAM role itself is created by isengardcli add-role (not Terraform); this only reads it and grants it in-cluster. Set false if the Isengard role does not exist yet."
  type        = bool
  default     = true
}

# The eks-cluster-admin role is Isengard-managed; read it so the access entry can
# reference its ARN. Requires the role to already exist (isengardcli add-role).
data "aws_iam_role" "eks_cluster_admin" {
  count = var.create_eks_cluster_admin_role ? 1 : 0
  name  = "eks-cluster-admin"
}

output "eks_cluster_admin_role_arn" {
  description = "ARN of the Isengard-owned EKS-only cluster-admin role wired to cluster-admin. Teammates federate into this (not Admin) for kubectl access with no account privileges."
  value       = var.create_eks_cluster_admin_role ? data.aws_iam_role.eks_cluster_admin[0].arn : null
}
