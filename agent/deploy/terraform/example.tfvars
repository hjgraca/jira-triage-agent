# Copy to terraform.tfvars and fill in from the customer's EXISTING cluster.
#
#   aws eks describe-cluster --name <cluster> --region <region> \
#     --query 'cluster.identity.oidc.issuer' --output text
#   aws iam list-open-id-connect-providers   # match the URL above to its ARN

name              = "acme-prod"
region            = "us-west-2"
oidc_provider_arn = "arn:aws:iam::111122223333:oidc-provider/oidc.eks.us-west-2.amazonaws.com/id/EXAMPLED539D4633E53DE1B716D3041E"

# Optional — pin to the model the customer has Bedrock access to.
# bedrock_model_id = "us.anthropic.claude-sonnet-4-6"

# Set on the SECOND apply, after the listener LB exists (see cloudfront.tf).
# listener_lb_dns = "a1b2c3d4e5f6-1234567890.us-west-2.elb.amazonaws.com"

tags = {
  app   = "jira-triage-agent"
  owner = "platform-team"
}
