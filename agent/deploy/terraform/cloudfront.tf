##############################################
# CloudFront → agent listener LoadBalancer (optional)
##############################################
# Gives Jira a public HTTPS endpoint with a valid AWS-managed cert (the default
# *.cloudfront.net domain) without buying a domain (R9). The origin is the
# listener's OWN dedicated LoadBalancer (agent/k8s/triage-listener.yaml), reached
# over HTTP since cluster TLS is off — TLS terminates at CloudFront.
#
# Skip this entirely if the customer already exposes the listener via their own
# ALB/Ingress with a domain + ACM cert: leave var.listener_lb_dns empty.
#
# Two-step apply (the LB hostname only exists after kubectl apply):
#   1. terraform apply                              # IRSA role only
#   2. kubectl apply -f agent/k8s/...               # creates the listener LB
#   3. terraform apply -var "listener_lb_dns=<elb-hostname>"   # adds CloudFront

locals {
  cf_enabled = var.listener_lb_dns != ""
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  count = local.cf_enabled ? 1 : 0
  name  = "Managed-CachingDisabled"
}

# Forward all viewer headers + body unmodified — any header drop or body
# transform breaks HMAC validation on the system-webhook path (R10a).
data "aws_cloudfront_origin_request_policy" "all_viewer" {
  count = local.cf_enabled ? 1 : 0
  name  = "Managed-AllViewer"
}

resource "aws_cloudfront_distribution" "agent" {
  count   = local.cf_enabled ? 1 : 0
  enabled = true
  comment = "${var.name} Jira triage webhook ingress"

  origin {
    origin_id   = "agent-listener"
    domain_name = var.listener_lb_dns
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only" # cluster TLS is off; HTTP to the ELB
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "agent-listener"
    viewer_protocol_policy = "https-only"
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

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = var.tags
}

# R10b origin lock. The listener LB's security group must allow inbound 80 ONLY
# from CloudFront's managed prefix list. With the LBC-managed NLB (the default —
# see agent/deploy/k8s/receiver.yaml), reference the prefix list as a SINGLE SG
# rule via the Service annotation `...-security-group-prefix-lists` — use the id
# output below. (The raw CIDR list is also surfaced, for the legacy classic-ELB /
# own-ALB paths, but note: ~45 CIDRs as classic-ELB loadBalancerSourceRanges
# overflow the 60-rules-per-SG limit and the LB won't provision — prefer the NLB.)
data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing" {
  count = local.cf_enabled ? 1 : 0
  name  = "com.amazonaws.global.cloudfront.origin-facing"
}

# The prefix-list id itself — the preferred origin lock for the NLB path. Not
# gated on cf_enabled because the Service manifest needs it before any LB exists.
data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing_id" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}
