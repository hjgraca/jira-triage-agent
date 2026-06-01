## Agentic-dev workshop platform — EKS + GitLab
##
## Usage:
##   make cluster      # provision VPC + EKS via Terraform
##   make kubeconfig   # point kubectl at the new cluster
##   make apps         # deploy GitLab
##   make up           # cluster + kubeconfig + apps (full bring-up)
##   make destroy      # tear everything down (runs orphan cleanup first)

REGION         ?= us-east-1
CLUSTER        ?= workshop
DOMAIN         ?= workshop.example.com
TF_DIR         := terraform

# Chart versions pinned for reproducibility.
# GitLab chart 8.x/9.x still bundles the in-cluster Postgres/Redis/MinIO
# subcharts; they are removed in chart 10.x (GitLab 19.0).
GITLAB_CHART_VERSION ?= 8.11.8

.PHONY: cluster kubeconfig apps up gitlab destroy clean-k8s-lb

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
