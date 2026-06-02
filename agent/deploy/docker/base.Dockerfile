# Base image: the generic runner ENGINE ONLY — listener + trigger + harness
# adapters. NO coding-agent CLI, and NO agents. It is fully reusable: harness
# images add a CLI (FROM this), and an agent image adds exactly one agent dir
# (FROM a harness image). Three layers, agent-blank until the last:
#
#   base.Dockerfile        engine only           ← this file
#   <harness>.Dockerfile   FROM base + the CLI   (still agent-blank)
#   agents/<x>/Dockerfile  FROM harness + 1 agent (the final, runnable image)
#
# Build context is the `agent/` directory. The Makefile orchestrates the chain —
# see `make image AGENT=<name> HARNESS=<name>`.
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

# The generic runner ENGINE only (zero third-party deps, no npm install needed):
#   runtime/listener  — server + runner + agent-def + auth + limits
#   runtime/trigger    — trigger adapters
#   runtime/harness    — harness adapters
# No agents here — an agent image (agents/<name>/Dockerfile) adds the one agent.
COPY runtime/package.json ./runtime/package.json
COPY runtime/listener ./runtime/listener
COPY runtime/trigger ./runtime/trigger
COPY runtime/harness ./runtime/harness

# Allowed-value config is mounted at runtime (ConfigMap); create the mount dir.
# /agents is created+owned here so the final agent layer can COPY into it as the
# non-root user.
RUN mkdir -p /etc/triage /agents \
 && chown -R triage:triage /app /agents /etc/triage /home/triage

USER triage

# tini → node listener. The agent image overrides nothing here; it only adds its
# one agent dir. The listener spawns the configured harness per webhook.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "runtime/listener/server.js"]
