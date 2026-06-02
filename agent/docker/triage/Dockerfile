# Triage agent image: the webhook listener + one or more headless coding-agent
# harnesses + the jira-triage skill. The listener picks the harness at runtime
# via the HARNESS env (see src/harness/); bake in whichever ones you'll use.
#
# Build args select which harnesses to install (keep the image lean — only
# install what you run):
#   --build-arg INSTALL_PI=true        (default) pi.dev, runs against Bedrock via IRSA
#   --build-arg INSTALL_KIRO=true      kiro-cli, its own backend (KIRO_API_KEY)
#   --build-arg INSTALL_OPENCODE=true  opencode, via `opencode run` (provider creds)
#
# Pinned to Node 20 LTS — pi's minimum Node version is undocumented (KTD9); 20
# is the conservative floor. Platform pinned to linux/amd64 to match the EKS
# node arch (m5 = x86_64); the Makefile also passes --platform.
FROM --platform=linux/amd64 node:20-slim

ARG INSTALL_PI=true
ARG INSTALL_KIRO=false
ARG INSTALL_OPENCODE=false

# tini as PID 1 reaps the one-shot harness subprocesses the listener spawns
# (KTD2/KTD9 — node as PID 1 does not reap, so zombies would accumulate).
# curl/git/jq back the skill's bundled scripts.
# unzip is needed by the kiro-cli installer (it ships a zip); harmless for pi.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini curl git jq unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# pi.dev coding agent. --ignore-scripts per the docs (no install scripts needed,
# safer in a locked-down build).
RUN if [ "$INSTALL_PI" = "true" ]; then \
      npm install -g --ignore-scripts @earendil-works/pi-coding-agent; \
    fi

# kiro-cli (https://kiro.dev/docs/cli/headless.md). The installer drops the
# binary in ~/.local/bin (= /root/.local/bin in this root build stage); relocate
# it onto a system PATH so the non-root runtime user can exec it. Fail the build
# if the binary can't be found afterwards, rather than shipping a broken image.
RUN if [ "$INSTALL_KIRO" = "true" ]; then \
      curl -fsSL https://cli.kiro.dev/install | bash \
      && bin="$(find /root/.local/bin "$HOME/.local/bin" -name kiro-cli -type f 2>/dev/null | head -n1)" \
      && [ -n "$bin" ] && install -m 0755 "$bin" /usr/local/bin/kiro-cli \
      && /usr/local/bin/kiro-cli --version; \
    fi

# opencode (https://opencode.ai/docs/cli). The installer drops the binary in
# ~/.opencode/bin or ~/.local/bin; relocate onto a system PATH for the non-root
# user. Fail the build if not found afterwards.
RUN if [ "$INSTALL_OPENCODE" = "true" ]; then \
      curl -fsSL https://opencode.ai/install | bash \
      && bin="$(find /root/.opencode/bin /root/.local/bin "$HOME/.opencode/bin" "$HOME/.local/bin" -name opencode -type f 2>/dev/null | head -n1)" \
      && [ -n "$bin" ] && install -m 0755 "$bin" /usr/local/bin/opencode \
      && /usr/local/bin/opencode --version; \
    fi

# Non-root with a writable HOME so a harness can write its dotdir
# (~/.pi, ~/.kiro / KIRO_HOME, ~/.local/share/opencode) (KTD11).
ENV HOME=/home/triage
RUN useradd --uid 10001 --create-home --home-dir /home/triage triage

WORKDIR /app

# Listener app (no third-party deps, so no npm install needed).
COPY listener/package.json ./listener/package.json
COPY listener/src ./listener/src

# Bake the skill at a fixed path. pi loads it via `--skill`; harnesses without a
# skill flag (kiro-cli) have the rubric inlined into the prompt and run the
# scripts below as tools (see src/harness/).
COPY skills/jira-triage /skills/jira-triage
RUN chmod +x /skills/jira-triage/scripts/*.sh

# Allowed-value config is mounted at runtime (ConfigMap) at this path; the skill
# scripts read TRIAGE_CONFIG. Create the dir so the mount target exists.
RUN mkdir -p /etc/triage && chown -R triage:triage /app /skills /etc/triage /home/triage

USER triage

# tini → node listener. The listener spawns the configured harness per webhook.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "listener/src/server.js"]
