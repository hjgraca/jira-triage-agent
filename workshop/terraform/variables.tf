variable "region" {
  description = "AWS region to deploy into. us-west-2 so the cluster OIDC provider, the Bedrock IRSA role (triage agent), and the live ELB are all in one region — IRSA binds the cluster's region-specific OIDC issuer, so Bedrock and the cluster cannot be split across regions."
  type        = string
  default     = "us-west-2"
}

variable "name" {
  description = "Name prefix for all resources (cluster, VPC, etc.)."
  type        = string
  default     = "workshop"
}

variable "kubernetes_version" {
  description = "EKS control plane Kubernetes version."
  type        = string
  default     = "1.30"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "node_instance_types" {
  description = "Instance types for the managed node group. GitLab alone wants ~8 vCPU/30GB, so default to m5.2xlarge."
  type        = list(string)
  default     = ["m5.2xlarge"]
}

variable "node_desired_size" {
  description = "Desired number of worker nodes."
  type        = number
  default     = 2
}

variable "node_min_size" {
  description = "Minimum number of worker nodes."
  type        = number
  default     = 1
}

variable "node_max_size" {
  description = "Maximum number of worker nodes."
  type        = number
  default     = 4
}

variable "node_disk_size" {
  description = "EBS volume size (GiB) per worker node."
  type        = number
  default     = 100
}

variable "tags" {
  description = "Tags applied to all resources."
  type        = map(string)
  default = {
    Project   = "agentic-dev-workshop"
    ManagedBy = "terraform"
  }
}
