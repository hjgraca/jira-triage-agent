##############################################
# CloudFront → triage webhook listener LoadBalancer
##############################################
# Gives Jira Cloud a public HTTPS endpoint with a valid AWS-managed cert (the
# default *.cloudfront.net domain) without buying a domain (R9). The origin is
# the listener's OWN dedicated LoadBalancer (KTD10), reached over HTTP since
# cluster TLS is off — TLS terminates at CloudFront.
#
# The listener LB is created by Kubernetes (k8s/triage-listener.yaml), so its
# hostname is only known AFTER `kubectl apply`. Pass it in as a variable on a
# second, targeted apply (see README "Triage agent"):
#   terraform apply -var "triage_listener_lb_dns=<elb-hostname>"
# Leave it empty to skip CloudFront on the main cluster apply.

variable "triage_listener_lb_dns" {
  description = "Hostname of the triage listener's LoadBalancer (the k8s-created ELB). Empty disables the CloudFront distribution; set it after the listener Service has an external hostname."
  type        = string
  default     = ""
}

locals {
  triage_cf_enabled = var.triage_listener_lb_dns != ""
}

# Caching disabled: webhooks are dynamic POSTs and must not be cached.
data "aws_cloudfront_cache_policy" "caching_disabled" {
  count = local.triage_cf_enabled ? 1 : 0
  name  = "Managed-CachingDisabled"
}

# Forward everything (headers incl. X-Hub-Signature + X-Atlassian-Webhook-*,
# and the raw body) to the origin unmodified — any header drop or body
# transform breaks HMAC validation (R10a).
data "aws_cloudfront_origin_request_policy" "all_viewer" {
  count = local.triage_cf_enabled ? 1 : 0
  name  = "Managed-AllViewer"
}

resource "aws_cloudfront_distribution" "triage" {
  count   = local.triage_cf_enabled ? 1 : 0
  enabled = true
  comment = "${var.name} Jira triage webhook ingress"

  origin {
    origin_id   = "triage-listener"
    domain_name = var.triage_listener_lb_dns
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only" # cluster TLS is off; HTTP to the ELB
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "triage-listener"
    viewer_protocol_policy = "https-only"
    # POST must be allowed or CloudFront 403s the webhook; cache only GET/HEAD.
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled[0].id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer[0].id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # Default *.cloudfront.net cert — no custom domain, no separate cert (R9).
  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = var.tags
}

output "triage_webhook_url" {
  description = "Public webhook URL to register in Jira (system webhook). Empty until triage_listener_lb_dns is set."
  value       = local.triage_cf_enabled ? "https://${aws_cloudfront_distribution.triage[0].domain_name}/jira-webhook" : ""
}

# ---------------------------------------------------------------------------
# R10b — origin lock: restrict the listener LB so only CloudFront can reach it.
#
# The listener LB's security group must allow inbound 80 ONLY from CloudFront's
# managed prefix list (com.amazonaws.global.cloudfront.origin-facing). Because
# the LB + its SG are created by Kubernetes (not Terraform), the cleanest place
# to apply this is the Service annotation, which the AWS Load Balancer
# Controller honors:
#
#   service.beta.kubernetes.io/load-balancer-source-ranges  (classic ELB)
#
# But that takes CIDRs, not a prefix-list id. The managed prefix list's CIDRs
# are exposed below so the operator can inject them into the Service (README
# documents the kubectl patch). This data source makes the current ranges
# available as a Terraform output rather than hand-copying from AWS docs.
data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing" {
  count = local.triage_cf_enabled ? 1 : 0
  name  = "com.amazonaws.global.cloudfront.origin-facing"
}

output "cloudfront_origin_cidrs" {
  description = "CloudFront origin-facing CIDRs to set as the listener Service's loadBalancerSourceRanges (R10b), so the public LB only accepts CloudFront."
  value       = local.triage_cf_enabled ? data.aws_ec2_managed_prefix_list.cloudfront_origin_facing[0].entries[*].cidr : []
}

# Preferred origin lock for the NLB path: reference this prefix list as a SINGLE
# SG rule via the receiver Service annotation
#   service.beta.kubernetes.io/aws-load-balancer-security-group-prefix-lists
# instead of expanding ~45 CIDRs into ~45 rules (which overflows the 60-rules-
# per-SG limit and is why the classic ELB never provisioned). Always available
# (not gated on triage_cf_enabled) because the manifest needs it before the
# first LB exists.
data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing_id" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

output "cloudfront_origin_prefix_list_id" {
  description = "CloudFront origin-facing managed prefix-list id for this region. Set it in the receiver Service's aws-load-balancer-security-group-prefix-lists annotation to lock the NLB to CloudFront with one SG rule (R10b)."
  value       = data.aws_ec2_managed_prefix_list.cloudfront_origin_facing_id.id
}
