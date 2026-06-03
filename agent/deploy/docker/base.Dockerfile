# Base image: the agent-runner ENGINE ONLY — receiver + runner + dispatch +
# trigger + harness adapters + shared lib. NO coding-agent CLI, NO agents, and
# nothing tied to any specific event source, harness, or agent. Fully reusable:
# a harness image adds a CLI (FROM this); an agent image adds exactly one agent
# (FROM a harness image). Three layers, agent-blank until the last:
#
#   base.Dockerfile        engine only           ← this file
#   <harness>.Dockerfile   FROM base + the CLI   (still agent-blank)
#   agents/<x>/Dockerfile  FROM harness + 1 agent (the final, runnable image)
#
# The same image is BOTH the receiver (CMD below) and the one-shot runner (a Job
# runs `node runtime/runner/main.js`); which one runs is just the command.
#
# Build context is the `agent/` directory. The Makefile orchestrates the chain —
# see `make image AGENT=<name> HARNESS=<name>`.
#
# Pinned to Node 20 LTS; platform pinned to linux/amd64 to match the EKS node
# arch (m5 = x86_64).
FROM --platform=linux/amd64 node:20-slim

# tini as PID 1 reaps one-shot subprocesses (node as PID 1 does not reap).
# curl/git/jq back agent scripts; unzip is needed by some harness installers.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini curl git jq unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Non-root with a writable HOME so a harness can write its dotdir.
ENV HOME=/home/app
RUN useradd --uid 10001 --create-home --home-dir /home/app app

WORKDIR /app

# The engine (zero third-party deps, so no npm install needed):
#   runtime/receiver  — stateless HTTP front door (auth → gate → dispatch)
#   runtime/runner    — one-shot run program (a Job/subprocess executes this)
#   runtime/dispatch  — how a run starts (k8s-job | exec)
#   runtime/trigger   — event-source adapters (jira | generic | …)
#   runtime/harness   — coding-agent CLI adapters (pi | kiro-cli | opencode | …)
#   runtime/lib       — shared: agent-def, auth, limits
# No agents here — an agent image (agents/<name>/Dockerfile) adds the one agent.
COPY runtime ./runtime

# /agents is created+owned here so the final agent layer can COPY into it as the
# non-root user. /etc/agent is the mount point for any runtime config.
RUN mkdir -p /etc/agent /agents \
 && chown -R app:app /app /agents /etc/agent /home/app

USER app

# Default command = the receiver. A run Job overrides this with
# `node runtime/runner/main.js`. tini reaps either way.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "runtime/receiver/server.js"]
