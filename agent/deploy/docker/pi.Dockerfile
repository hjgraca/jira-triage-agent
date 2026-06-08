# pi harness image = base runner + the pi.dev CLI.
# pi authenticates to Bedrock via IRSA (no API key in the image).
#
#   docker buildx build --platform linux/amd64 \
#     -f deploy/docker/pi.Dockerfile -t <repo> --build-arg BASE=agent-base agent
ARG BASE=agent-base
FROM ${BASE}

USER root
# --ignore-scripts per pi's docs (no install scripts needed; safer locked down).
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent \
 && command -v pi
USER agent
