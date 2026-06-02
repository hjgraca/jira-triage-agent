# Base image: the generic runner (listener + trigger + harness adapters) + the
# agent implementations (skills), with NO coding-agent CLI installed. The
# per-harness Dockerfiles (pi.Dockerfile, kiro.Dockerfile, opencode.Dockerfile)
# build FROM this and add just their CLI — so the listener/agent copy logic and
# Node setup live in exactly one place.
#
# Build context is the `agent/` directory. Build + tag this first:
#   docker buildx build --platform linux/amd64 -f deploy/docker/base.Dockerfile -t triage-base agent
# then a harness image:
#   docker buildx build --platform linux/amd64 -f deploy/docker/pi.Dockerfile -t <repo>:latest --build-arg BASE=triage-base agent
# (the Makefile orchestrates this — see `make image HARNESS=...`).
#
# Pinned to Node 20 LTS; platform pinned to linux/amd64 to match the EKS node
# arch (m5 = x86_64).
FROM --platform=linux/amd64 node:20-slim

# tini as PID 1 reaps the one-shot harness subprocesses the listener spawns
# (KTD2/KTD9 — node as PID 1 does not reap). curl/git/jq back the skill scripts;
# unzip is needed by some harness installers (kiro). ca-certificates for TLS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini curl git jq unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Non-root with a writable HOME so a harness can write its dotdir
# (~/.pi, ~/.kiro / KIRO_HOME, ~/.local/share/opencode) (KTD11).
ENV HOME=/home/triage
RUN useradd --uid 10001 --create-home --home-dir /home/triage triage

WORKDIR /app

# The generic runner (zero third-party deps, so no npm install needed):
#   runtime/listener  — server + agent-def + auth + limits + gate
#   runtime/trigger    — trigger adapters
#   runtime/harness    — harness adapters
COPY runtime/package.json ./runtime/package.json
COPY runtime/listener ./runtime/listener
COPY runtime/trigger ./runtime/trigger
COPY runtime/harness ./runtime/harness

# Bake the agent implementations at /agents/<name>. Each agent dir's SKILL.md
# frontmatter is its definition; AGENT_PATH selects which one runs.
COPY agents /agents
RUN chmod +x /agents/*/scripts/*.sh 2>/dev/null || true

# Allowed-value config is mounted at runtime (ConfigMap); create the mount dir.
RUN mkdir -p /etc/triage \
 && chown -R triage:triage /app /agents /etc/triage /home/triage

USER triage

# tini → node listener. The listener spawns the configured harness per webhook.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "runtime/listener/server.js"]
