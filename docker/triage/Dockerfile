# Triage agent image: the webhook listener + the pi.dev coding harness + the
# jira-triage skill, runnable headless against Bedrock via IRSA.
#
# Pinned to Node 20 LTS — pi's minimum Node version is undocumented (KTD9); 20
# is the conservative floor. Bump only after confirming pi runs on the target.
# Platform pinned to linux/amd64 to match the EKS node arch (m5 = x86_64); the
# Makefile also passes --platform, this is belt-and-suspenders for direct builds.
FROM --platform=linux/amd64 node:20-slim

# tini as PID 1 reaps the one-shot pi subprocesses the listener spawns (KTD2/KTD9
# — node as PID 1 does not reap, so zombies would accumulate). curl/git/jq back
# the skill's bundled scripts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini curl git jq ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# pi.dev coding agent. --ignore-scripts per the docs (no install scripts needed,
# safer in a locked-down build).
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# Non-root with a writable HOME so pi can write ~/.pi (KTD11).
ENV HOME=/home/triage
RUN useradd --uid 10001 --create-home --home-dir /home/triage triage

WORKDIR /app

# Listener app (no third-party deps, so no npm install needed).
COPY listener/package.json ./listener/package.json
COPY listener/src ./listener/src

# Bake the skill at a fixed path; the listener passes it via `pi --skill`
# (KTD11 — explicit, not relying on auto-discovery in --mode json).
COPY skills/jira-triage /skills/jira-triage
RUN chmod +x /skills/jira-triage/scripts/*.sh

# Allowed-value config is mounted at runtime (ConfigMap) at this path; the skill
# scripts read TRIAGE_CONFIG. Create the dir so the mount target exists.
RUN mkdir -p /etc/triage && chown -R triage:triage /app /skills /etc/triage /home/triage

USER triage

# tini → node listener. The listener spawns `pi` per webhook.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "listener/src/server.js"]
