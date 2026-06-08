# Base image: the runner ENGINE only — receiver + run entrypoints, trigger and
# harness adapters, shared lib. NO coding-agent CLI, NO agents. Fully reusable:
# harness images add a CLI (FROM this), an agent image adds exactly one agent dir
# (FROM a harness image). Three layers, agent-blank until the last:
#
#   base.Dockerfile        engine only           ← this file
#   <harness>.Dockerfile   FROM base + the CLI   (still agent-blank)
#   agents/<x>/Dockerfile  FROM harness + 1 agent (the final, runnable image)
#
# The final image carries BOTH entrypoints:
#   node runtime/receiver.js  → the webhook receiver Deployment (creates run Jobs)
#   node runtime/run.js       → one run Job per event (spawns the harness, exits)
#
# Build context is the `agent/` directory; the Makefile orchestrates the chain.
# Node 20 LTS; linux/amd64 to match the EKS node arch (m5 = x86_64).
FROM --platform=linux/amd64 node:20-slim

# tini as PID 1 reaps the harness subprocess a run Job spawns (node as PID 1 does
# not reap). curl/git/jq back the agents' bundled scripts; unzip for some harness
# installers (kiro); ca-certificates for TLS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini curl git jq unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Non-root with a writable HOME so a harness can write its dotdir
# (~/.pi, ~/.kiro / KIRO_HOME, ~/.local/share/opencode).
ENV HOME=/home/agent
RUN useradd --uid 10001 --create-home --home-dir /home/agent agent

WORKDIR /app

# The engine (zero third-party deps, so no npm install):
#   runtime/receiver.js + run.js  — the two entrypoints
#   runtime/lib                    — auth, agent-def, job, k8s
#   runtime/trigger / harness      — adapters
# No agents here — an agent image (agents/<name>/Dockerfile) adds the one agent.
COPY runtime/package.json ./runtime/package.json
COPY runtime/receiver.js ./runtime/receiver.js
COPY runtime/run.js ./runtime/run.js
COPY runtime/lib ./runtime/lib
COPY runtime/trigger ./runtime/trigger
COPY runtime/harness ./runtime/harness

# /agents created+owned here so the final agent layer can COPY into it as the
# non-root user.
RUN mkdir -p /agents && chown -R agent:agent /app /agents /home/agent

USER agent

# Default command is the receiver; run Jobs override it with `node runtime/run.js`.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "runtime/receiver.js"]
