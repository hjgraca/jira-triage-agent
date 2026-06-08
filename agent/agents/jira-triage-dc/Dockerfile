# jira-triage-dc agent image = a harness image (engine + one CLI) + THIS one agent.
#
# The Data Center / Server sibling of jira-triage. One agent per image, deployed
# in isolation. BASE must be a harness image built from
# deploy/docker/<harness>.Dockerfile (which is FROM deploy/docker/base.Dockerfile).
# Build context is the `agent/` directory.
#
#   make agent-image AGENT=jira-triage-dc HARNESS=pi
#   # or raw:
#   #   docker build -f deploy/docker/base.Dockerfile     -t agent-base:local        agent
#   #   docker build -f deploy/docker/pi.Dockerfile        --build-arg BASE=agent-base:local -t agent-pi:local agent
#   #   docker build -f agents/jira-triage-dc/Dockerfile   --build-arg BASE=agent-pi:local   -t <repo>:latest  agent
ARG BASE=agent-pi:local
FROM ${BASE}

# Copy exactly this one agent. The base created+owns /agents as uid 10001, so
# this lands writable by the runtime user; chmod its bundled scripts.
COPY --chown=10001:10001 agents/jira-triage-dc /agents/jira-triage-dc
RUN chmod +x /agents/jira-triage-dc/scripts/*.sh 2>/dev/null || true

# This image IS the jira-triage-dc agent: default AGENT_PATH to it (still
# overridable by the Deployment env). The skill's SKILL.md frontmatter drives it.
ENV AGENT_PATH=/agents/jira-triage-dc
