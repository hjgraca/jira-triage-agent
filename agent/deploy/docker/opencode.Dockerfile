# opencode harness image = base runner + the opencode CLI.
# opencode authenticates via the AWS credential chain (amazon-bedrock provider →
# IRSA AWS_WEB_IDENTITY_TOKEN_FILE/AWS_ROLE_ARN) or provider env vars / auth.json,
# all supplied at runtime — no key baked in.
#
#   docker buildx build --platform linux/amd64 \
#     -f deploy/docker/opencode.Dockerfile -t <repo> --build-arg BASE=agent-base agent
ARG BASE=agent-base
FROM ${BASE}

USER root
# The installer drops the binary in $HOME/.opencode/bin (or ~/.local/bin) — and
# the base image sets HOME=/home/agent, so it lands there, NOT in /root. Search
# both; relocate onto a system PATH for the non-root user. Fail the build if not
# found, rather than shipping a broken image.
RUN curl -fsSL https://opencode.ai/install | bash \
 && bin="$(find /home/agent/.opencode/bin /home/agent/.local/bin /root/.opencode/bin /root/.local/bin "$HOME/.opencode/bin" \
             -name opencode -type f 2>/dev/null | head -n1)" \
 && [ -n "$bin" ] || { echo 'opencode not found after install'; exit 1; } \
 && install -m 0755 "$bin" /usr/local/bin/opencode \
 && /usr/local/bin/opencode --version
# The installer ran as root and may leave /home/agent/.opencode|.local root-owned,
# so the non-root runtime user can't write opencode's state/config. Pre-create and
# hand the home back to the agent user (same fix as the kiro image).
RUN mkdir -p /home/agent/.local/share /home/agent/.config /home/agent/.opencode \
 && chown -R 10001:10001 /home/agent
USER agent
