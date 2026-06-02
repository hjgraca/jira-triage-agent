## Agentic-dev workshop platform — EKS + GitLab
##
## Usage:
##   make cluster        # provision VPC + EKS via Terraform
##   make kubeconfig     # point kubectl at the new cluster
##   make apps           # deploy GitLab
##   make up             # cluster + kubeconfig + apps (full bring-up)
##   make triage-image   # build + push the triage agent image to ECR
##   make destroy        # tear everything down (runs orphan cleanup first)

REGION         ?= us-west-2
CLUSTER        ?= workshop
DOMAIN         ?= workshop.example.com
TF_DIR         := terraform

# Chart versions pinned for reproducibility.
# GitLab chart 8.x/9.x still bundles the in-cluster Postgres/Redis/MinIO
# subcharts; they are removed in chart 10.x (GitLab 19.0).
GITLAB_CHART_VERSION ?= 8.11.8

# Triage agent image. Pushed to ECR in the cluster's account/region.
TRIAGE_ECR_REPO ?= triage-agent
TRIAGE_IMAGE_TAG ?= latest
ACCOUNT_ID = $(shell aws sts get-caller-identity --query Account --output text)
TRIAGE_IMAGE = $(ACCOUNT_ID).dkr.ecr.$(REGION).amazonaws.com/$(TRIAGE_ECR_REPO):$(TRIAGE_IMAGE_TAG)

.PHONY: cluster kubeconfig apps up gitlab triage-image destroy clean-k8s-lb

cluster:
	cd $(TF_DIR) && terraform init && terraform apply \
		-var "region=$(REGION)" -var "name=$(CLUSTER)"

kubeconfig:
	aws eks update-kubeconfig --region $(REGION) --name $(CLUSTER)

apps: gitlab

gitlab:
	helm repo add gitlab https://charts.gitlab.io/
	helm repo update
	helm upgrade --install gitlab gitlab/gitlab \
		--version $(GITLAB_CHART_VERSION) \
		--namespace gitlab --create-namespace \
		--values helm/gitlab-values.yaml \
		--set global.hosts.domain=$(DOMAIN) \
		--timeout 600s
	# Git-over-SSH runs on its own IP-restricted LoadBalancer (SSH is disabled
	# on the shared nginx LB; see helm/gitlab-values.yaml). Edit the source
	# range in this manifest when your public IP changes.
	kubectl apply -f k8s/gitlab-shell-ssh-lb.yaml

## Build and push the triage agent image (listener + pi + jira-triage skill).
## Creates the ECR repo if absent, logs in, builds, and pushes.
triage-image:
	aws ecr describe-repositories --region $(REGION) --repository-names $(TRIAGE_ECR_REPO) >/dev/null 2>&1 \
		|| aws ecr create-repository --region $(REGION) --repository-name $(TRIAGE_ECR_REPO) >/dev/null
	aws ecr get-login-password --region $(REGION) \
		| docker login --username AWS --password-stdin $(ACCOUNT_ID).dkr.ecr.$(REGION).amazonaws.com
	docker build -f docker/triage/Dockerfile -t $(TRIAGE_IMAGE) .
	docker push $(TRIAGE_IMAGE)
	@echo "Pushed $(TRIAGE_IMAGE)"

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
