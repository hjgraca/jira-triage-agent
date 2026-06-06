# Copy to terraform.tfvars and fill in from the customer's EXISTING cluster.
#
#   aws eks describe-cluster --name <cluster> --region <region> \
#     --query 'cluster.identity.oidc.issuer' --output text
#   aws iam list-open-id-connect-providers   # match the URL above to its ARN

name              = "acme-prod"
region            = "eu-west-1"
oidc_provider_arn = "arn:aws:iam::111122223333:oidc-provider/oidc.eks.eu-west-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B716D3041E"

# Optional — pin to the model the customer has Bedrock access to. The default is
# the EU inference profile (eu.*) so inference stays in-region; if you change it,
# change MODEL/OPENCODE_MODEL + AWS_REGION in receiver.yaml to MATCH, or the
# scoped IAM policy denies the InvokeModel call.
# bedrock_model_id = "eu.anthropic.claude-sonnet-4-6"

# Set on the SECOND apply, after the listener LB exists (see cloudfront.tf).
# listener_lb_dns = "a1b2c3d4e5f6-1234567890.eu-west-1.elb.amazonaws.com"

tags = {
  app   = "jira-triage-agent"
  owner = "platform-team"
}
