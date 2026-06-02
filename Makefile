## Agentic-dev WORKSHOP platform — EKS + GitLab + the triage agent.
##
## This Makefile builds the full LAB (workshop/terraform + GitLab + the agent),
## used to develop and demo the agent end to end. To install ONLY the agent into
## a customer's existing cluster, do NOT use this — follow docs/customer-install/
## (which uses agent/deploy/terraform + agent/deploy/k8s against their own cluster).
##
## Usage:
##   make cluster        # provision VPC + EKS via Terraform (workshop/terraform)
##   make kubeconfig     # point kubectl at the new cluster
##   make apps           # deploy GitLab + the agent
##   make up             # cluster + kubeconfig + apps (full bring-up)
##   make triage-image   # build + push the triage agent image to ECR
##   make destroy        # tear everything down (runs orphan cleanup first)

REGION         ?= us-west-2
CLUSTER        ?= workshop
DOMAIN         ?= workshop.example.com
TF_DIR         := workshop/terraform

# Chart versions pinned for reproducibility.
# GitLab chart 8.x/9.x still bundles the in-cluster Postgres/Redis/MinIO
# subcharts; they are removed in chart 10.x (GitLab 19.0).
GITLAB_CHART_VERSION ?= 8.11.8

# Agent image. Built as three layers, agent-blank until the last:
#   base (engine) → <HARNESS> (engine + CLI) → <AGENT> (one agent).
# AGENT selects agents/<name>/Dockerfile (the final image); HARNESS selects the
# CLI (pi|kiro|opencode). One agent per image, deployed in isolation.
TRIAGE_ECR_REPO ?= triage-agent
AGENT   ?= jira-triage
HARNESS ?= pi
# Tag encodes agent+harness so distinct combos don't clobber each other in ECR.
TRIAGE_IMAGE_TAG ?= $(AGENT)-$(HARNESS)
ACCOUNT_ID = $(shell aws sts get-caller-identity --query Account --output text)
TRIAGE_IMAGE = $(ACCOUNT_ID).dkr.ecr.$(REGION).amazonaws.com/$(TRIAGE_ECR_REPO):$(TRIAGE_IMAGE_TAG)
TRIAGE_BASE_TAG    := triage-base:local
TRIAGE_HARNESS_TAG := triage-$(HARNESS):local

.PHONY: cluster kubeconfig apps up gitlab triage triage-image destroy clean-k8s-lb

cluster:
	cd $(TF_DIR) && terraform init && terraform apply \
		-var "region=$(REGION)" -var "name=$(CLUSTER)"

kubeconfig:
	aws eks update-kubeconfig --region $(REGION) --name $(CLUSTER)

apps: gitlab triage

gitlab:
	helm repo add gitlab https://charts.gitlab.io/
	helm repo update
	helm upgrade --install gitlab gitlab/gitlab \
		--version $(GITLAB_CHART_VERSION) \
		--namespace gitlab --create-namespace \
		--values workshop/helm/gitlab-values.yaml \
		--set global.hosts.domain=$(DOMAIN) \
		--timeout 600s
	# Git-over-SSH runs on its own IP-restricted LoadBalancer (SSH is disabled
	# on the shared nginx LB; see workshop/helm/gitlab-values.yaml). Edit the
	# source range in this manifest when your public IP changes.
	kubectl apply -f workshop/k8s/gitlab-shell-ssh-lb.yaml

## Build and push one agent image: AGENT (default jira-triage) × HARNESS (pi).
## Three layers: base (engine) → harness (engine + CLI) → agent (one agent).
##   make triage-image AGENT=jira-triage HARNESS=kiro
## Creates the ECR repo if absent, logs in, builds, and pushes.
triage-image:
	aws ecr describe-repositories --region $(REGION) --repository-names $(TRIAGE_ECR_REPO) >/dev/null 2>&1 \
		|| aws ecr create-repository --region $(REGION) --repository-name $(TRIAGE_ECR_REPO) >/dev/null
	aws ecr get-login-password --region $(REGION) \
		| docker login --username AWS --password-stdin $(ACCOUNT_ID).dkr.ecr.$(REGION).amazonaws.com
	# Pin linux/amd64 to match the EKS node arch (m5 = x86_64). Build context is
	# agent/. base (engine) → harness (engine + CLI) → agent (one agent).
	docker buildx build --platform linux/amd64 \
		-f agent/deploy/docker/base.Dockerfile -t $(TRIAGE_BASE_TAG) --load agent
	docker buildx build --platform linux/amd64 \
		-f agent/deploy/docker/$(HARNESS).Dockerfile --build-arg BASE=$(TRIAGE_BASE_TAG) \
		-t $(TRIAGE_HARNESS_TAG) --load agent
	docker buildx build --platform linux/amd64 \
		-f agent/agents/$(AGENT)/Dockerfile --build-arg BASE=$(TRIAGE_HARNESS_TAG) \
		-t $(TRIAGE_IMAGE) --push agent
	@echo "Pushed $(TRIAGE_IMAGE) (agent=$(AGENT), harness=$(HARNESS), linux/amd64)"

## Deploy the Jira triage agent. Applies namespace/SA, config, secrets,
## NetworkPolicy, and the listener (Deployment + dedicated LoadBalancer).
## Prerequisites the operator must do first (see docs/customer-install/):
##   - `make triage-image` to build/push the image, then set <TRIAGE_IMAGE> in
##     agent/deploy/k8s/triage-listener.yaml
##   - set the IRSA role ARN in agent/deploy/k8s/triage-namespace.yaml
##   - create agent/deploy/k8s/triage-{secrets,config}.yaml from the .example templates
##   - set AUTHORIZED_ACTORS + JIRA_BASE_URL in agent/deploy/k8s/triage-listener.yaml
triage:
	@if [ ! -f agent/deploy/k8s/triage-secrets.yaml ] || [ ! -f agent/deploy/k8s/triage-config.yaml ]; then \
		echo "Skipping triage: create agent/deploy/k8s/triage-secrets.yaml and agent/deploy/k8s/triage-config.yaml"; \
		echo "from the .example templates first (see docs/customer-install/). Then: make triage"; \
	else \
		kubectl apply -f agent/deploy/k8s/triage-namespace.yaml; \
		kubectl apply -f agent/deploy/k8s/triage-config.yaml; \
		kubectl apply -f agent/deploy/k8s/triage-secrets.yaml; \
		kubectl apply -f agent/deploy/k8s/triage-netpol.yaml; \
		kubectl apply -f agent/deploy/k8s/triage-listener.yaml; \
		echo "Triage listener applied. Get its LB hostname for CloudFront:"; \
		echo "  kubectl get svc -n triage triage-listener -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'"; \
	fi

up: cluster kubeconfig apps

## Delete Kubernetes-created LoadBalancers/ingresses BEFORE terraform destroy.
## These are created out-of-band and otherwise orphan ENIs/ELBs that block
## VPC deletion.
clean-k8s-lb:
	-kubectl delete svc --all-namespaces --field-selector spec.type=LoadBalancer --wait=true
	-kubectl delete ingress --all-namespaces --all --wait=true
	@echo "Waiting 60s for AWS to reconcile load balancer / ENI deletion..."
	sleep 60

destroy: clean-k8s-lb
	cd $(TF_DIR) && terraform destroy \
		-var "region=$(REGION)" -var "name=$(CLUSTER)"
