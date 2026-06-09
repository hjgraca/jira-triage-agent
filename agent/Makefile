## Self-contained Makefile for the agent (run from the agent/ directory).
##
## It does NOT build a cluster, GitLab, or anything in the workshop lab — it only
## builds/pushes the agent image and applies the manifests. (The repo-root
## Makefile, with the lab bring-up targets, is separate.)
##
## Run these from the agent/ directory:
##   make agent-image REGISTRY=<host>/<path> AGENT=jira-triage-dc HARNESS=pi   # build + push one image
##   make test                                                                 # run the unit tests
##   make agent-deploy-dc                                                       # kubectl apply the DC overlay
##
## REGISTRY-AGNOSTIC. The image is pushed to whatever registry REGISTRY points at
## — ECR, Sonatype Nexus, Harbor, GCR, GHCR, Docker Hub, a self-hosted registry,
## anything `docker push` can reach. Examples:
##   REGISTRY=111122223333.dkr.ecr.eu-west-1.amazonaws.com/triage-agent   (ECR)
##   REGISTRY=nexus.corp.internal:8891/triage-agent                       (Nexus)
##   REGISTRY=harbor.corp/library/triage-agent                            (Harbor)
## You must `docker login` to that registry yourself first (for ECR there's a
## convenience target: `make ecr-login REGION=… ECR_REPO=…`). Build context is
## THIS directory (agent/); the three Dockerfiles live under deploy/docker/ and
## agents/<name>/.

AGENT          ?= jira-triage-dc
HARNESS        ?= pi
# The registry + repository path to push to — NO tag (the tag is appended below).
# Override per the examples in the header. Defaults to a bare local repo name so
# `make agent-image` fails loudly with a push error rather than silently using
# someone's account.
REGISTRY       ?= triage-agent
# Tag encodes agent+harness so distinct combos don't clobber each other.
# Override to iterate on prompts without a stale cached image, e.g.
#   make agent-image AGENT_IMAGE_TAG=jira-triage-dc-pi-v2
AGENT_IMAGE_TAG ?= $(AGENT)-$(HARNESS)
AGENT_IMAGE     ?= $(REGISTRY):$(AGENT_IMAGE_TAG)
AGENT_BASE_TAG    := agent-base:local
AGENT_HARNESS_TAG := agent-$(HARNESS):local

# ECR-only convenience: log in + create the repo. Optional — skip entirely for
# Nexus/Harbor/etc. (just `docker login` to your registry instead).
REGION   ?= eu-west-1
ECR_REPO ?= triage-agent

.PHONY: agent-image ecr-login test agent-deploy-dc

## Build and push one agent image: AGENT (default jira-triage-dc) x HARNESS (pi).
## Three layers: base (engine) -> harness (engine + CLI) -> agent (one agent).
## Pushes to $(AGENT_IMAGE). Pins linux/amd64 to match EKS node arch.
## Pre-req: you are `docker login`'d to the target registry (see `ecr-login` for ECR).
agent-image:
	docker buildx build --platform linux/amd64 \
		-f deploy/docker/base.Dockerfile -t $(AGENT_BASE_TAG) --load .
	docker buildx build --platform linux/amd64 \
		-f deploy/docker/$(HARNESS).Dockerfile --build-arg BASE=$(AGENT_BASE_TAG) \
		-t $(AGENT_HARNESS_TAG) --load .
	docker buildx build --platform linux/amd64 \
		-f agents/$(AGENT)/Dockerfile --build-arg BASE=$(AGENT_HARNESS_TAG) \
		-t $(AGENT_IMAGE) --push .
	@echo "Pushed $(AGENT_IMAGE) (agent=$(AGENT), harness=$(HARNESS), linux/amd64)"

## ECR convenience (optional): create the repo if missing + docker login.
## For any other registry, just `docker login <host>` yourself and skip this.
ecr-login:
	@ACCT=$$(aws sts get-caller-identity --query Account --output text); \
	aws ecr describe-repositories --region $(REGION) --repository-names $(ECR_REPO) >/dev/null 2>&1 \
		|| aws ecr create-repository --region $(REGION) --repository-name $(ECR_REPO) >/dev/null; \
	aws ecr get-login-password --region $(REGION) \
		| docker login --username AWS --password-stdin $$ACCT.dkr.ecr.$(REGION).amazonaws.com; \
	echo "Logged in to $$ACCT.dkr.ecr.$(REGION).amazonaws.com (repo $(ECR_REPO)). Now:"; \
	echo "  make agent-image REGISTRY=$$ACCT.dkr.ecr.$(REGION).amazonaws.com/$(ECR_REPO)"

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
