## Self-contained Makefile for the SHIPPED agent (agent/ as the repo root).
##
## This is the customer-facing Makefile: it lives INSIDE the delivered subset
## (agent/), so `make agent-image …` works from the directory you extracted the
## handoff archive into. It does NOT build a cluster, GitLab, or anything in the
## workshop lab — it only builds/pushes the agent image and applies the manifests.
## (The repo-root Makefile, with the lab bring-up targets, is NOT shipped.)
##
## Run these from the agent/ directory:
##   make agent-image AGENT=jira-triage-dc HARNESS=pi       # build + push one image
##   make test                                              # run the unit tests
##   make agent-deploy-dc                                   # kubectl apply the DC overlay
##
## Build context is THIS directory (agent/); the three Dockerfiles live under
## deploy/docker/ and agents/<name>/.

REGION         ?= eu-west-1
AGENT_ECR_REPO ?= triage-agent
AGENT          ?= jira-triage-dc
HARNESS        ?= pi
# Tag encodes agent+harness so distinct combos don't clobber each other in ECR.
# Override to iterate on prompts without a stale cached image, e.g.
#   make agent-image AGENT_IMAGE_TAG=jira-triage-dc-pi-v2
AGENT_IMAGE_TAG ?= $(AGENT)-$(HARNESS)
ACCOUNT_ID  = $(shell aws sts get-caller-identity --query Account --output text)
AGENT_IMAGE = $(ACCOUNT_ID).dkr.ecr.$(REGION).amazonaws.com/$(AGENT_ECR_REPO):$(AGENT_IMAGE_TAG)
AGENT_BASE_TAG    := agent-base:local
AGENT_HARNESS_TAG := agent-$(HARNESS):local

.PHONY: agent-image test agent-deploy-dc

## Build and push one agent image: AGENT (default jira-triage-dc) x HARNESS (pi).
## Three layers: base (engine) -> harness (engine + CLI) -> agent (one agent).
## Creates the ECR repo if missing. Pins linux/amd64 to match EKS node arch.
agent-image:
	aws ecr describe-repositories --region $(REGION) --repository-names $(AGENT_ECR_REPO) >/dev/null 2>&1 \
		|| aws ecr create-repository --region $(REGION) --repository-name $(AGENT_ECR_REPO) >/dev/null
	aws ecr get-login-password --region $(REGION) \
		| docker login --username AWS --password-stdin $(ACCOUNT_ID).dkr.ecr.$(REGION).amazonaws.com
	docker buildx build --platform linux/amd64 \
		-f deploy/docker/base.Dockerfile -t $(AGENT_BASE_TAG) --load .
	docker buildx build --platform linux/amd64 \
		-f deploy/docker/$(HARNESS).Dockerfile --build-arg BASE=$(AGENT_BASE_TAG) \
		-t $(AGENT_HARNESS_TAG) --load .
	docker buildx build --platform linux/amd64 \
		-f agents/$(AGENT)/Dockerfile --build-arg BASE=$(AGENT_HARNESS_TAG) \
		-t $(AGENT_IMAGE) --push .
	@echo "Pushed $(AGENT_IMAGE) (agent=$(AGENT), harness=$(HARNESS), linux/amd64)"

## Run the unit tests (runtime + the selected agent's script tests). No cluster.
test:
	cd runtime && node --test
	bash agents/$(AGENT)/tests/run.sh

## Apply the Data Center / in-cluster overlay. Prereqs (see
## docs/customer-install/04b-deploy-data-center-in-cluster.md):
##   - deploy/k8s/dc/irsa-bedrock.sh has created the IRSA role; its ARN is in namespace.yaml
##   - deploy/k8s/{secrets,config}.yaml created from the .example templates
##   - image/AGENT_IMAGE/AUTHORIZED_ACTORS filled in deploy/k8s/dc/receiver.yaml
agent-deploy-dc:
	@if [ ! -f deploy/k8s/secrets.yaml ] || [ ! -f deploy/k8s/config.yaml ]; then \
		echo "Create deploy/k8s/secrets.yaml and deploy/k8s/config.yaml from the .example"; \
		echo "templates first (see docs/customer-install/04b-…). Then: make agent-deploy-dc"; \
	else \
		kubectl apply -f deploy/k8s/namespace.yaml; \
		kubectl apply -f deploy/k8s/rbac.yaml; \
		kubectl apply -f deploy/k8s/resourcequota.yaml; \
		kubectl apply -f deploy/k8s/netpol.yaml; \
		kubectl apply -f deploy/k8s/dc/ingress-netpol.yaml; \
		kubectl apply -f deploy/k8s/config.yaml; \
		kubectl apply -f deploy/k8s/secrets.yaml; \
		kubectl apply -f deploy/k8s/dc/receiver.yaml; \
		kubectl -n agents rollout status deploy/agent-receiver; \
	fi
