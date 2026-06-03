##############################################
# AWS Load Balancer Controller (LBC)
##############################################
# Why this exists: the receiver's webhook ingress must be locked so ONLY
# CloudFront can reach it (R10b). The clean lock is one inbound rule referencing
# the CloudFront-managed prefix list `com.amazonaws.global.cloudfront.origin-
# facing`. The in-tree (legacy) cloud provider can't do that — given
# `loadBalancerSourceRanges` it expands them into ONE SG rule PER CIDR (45 of
# them), which blows past the 60-rules-per-SG limit and the LB never provisions
# (RulesPerSecurityGroupLimitExceeded). The LBC can reference a prefix list as a
# single rule, so the receiver runs behind an LBC-managed NLB instead (see
# agent/deploy/k8s/receiver.yaml). This module installs the controller.
#
# The subnets are already tagged for LBC auto-discovery (kubernetes.io/role/elb
# + /internal-elb) in main.tf, so no extra subnet wiring is needed.

# IRSA role for the controller. The IAM module ships a maintained, least-
# privilege LBC policy behind `attach_load_balancer_controller_policy` — prefer
# it over hand-rolling (and over the orphaned manual AWSLoadBalancerController-
# IAMPolicy from an earlier attempt, which this does not use).
module "lb_controller_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.39"

  role_name                              = "${var.name}-lb-controller"
  attach_load_balancer_controller_policy = true

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:aws-load-balancer-controller"]
    }
  }

  tags = var.tags
}

# The controller's ServiceAccount, IRSA-annotated. Created in Terraform (not by
# the Helm chart) so the role ARN annotation is wired before the pods start.
resource "kubernetes_service_account_v1" "lb_controller" {
  metadata {
    name      = "aws-load-balancer-controller"
    namespace = "kube-system"
    labels = {
      "app.kubernetes.io/name"       = "aws-load-balancer-controller"
      "app.kubernetes.io/managed-by" = "terraform"
    }
    annotations = {
      "eks.amazonaws.com/role-arn" = module.lb_controller_irsa.iam_role_arn
    }
  }
}

resource "helm_release" "lb_controller" {
  name       = "aws-load-balancer-controller"
  repository = "https://aws.github.io/eks-charts"
  chart      = "aws-load-balancer-controller"
  version    = "1.8.1"
  namespace  = "kube-system"

  # helm provider v3: `set` is a list attribute of {name,value} objects.
  set = [
    { name = "clusterName", value = module.eks.cluster_name },
    { name = "region", value = var.region },
    { name = "vpcId", value = module.vpc.vpc_id },
    # Use the SA we created with the IRSA annotation; don't let the chart make one.
    { name = "serviceAccount.create", value = "false" },
    { name = "serviceAccount.name", value = kubernetes_service_account_v1.lb_controller.metadata[0].name },
  ]

  depends_on = [kubernetes_service_account_v1.lb_controller]
}
