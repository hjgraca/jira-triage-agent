# kiro-cli harness image = base runner + the kiro-cli CLI.
# kiro authenticates to its own backend via KIRO_API_KEY (injected at runtime).
#
#   docker buildx build --platform linux/amd64 \
#     -f deploy/docker/kiro.Dockerfile -t <repo> --build-arg BASE=agent-base agent
ARG BASE=agent-base
FROM ${BASE}

USER root
# The installer drops the binary in $HOME/.local/bin — and the base image sets
# HOME=/home/agent, so it lands there, NOT in /root. Search both (and a couple of
# fallbacks) so this is robust to where the installer puts it; relocate onto a
# system PATH so the non-root runtime user can exec it. Fail the build if it's
# not found, rather than shipping a broken image.
RUN curl -fsSL https://cli.kiro.dev/install | bash \
 && bin="$(find /home/agent/.local/bin /root/.local/bin /usr/local/bin "$HOME/.local/bin" \
             -name kiro-cli -type f 2>/dev/null | head -n1)" \
 && [ -n "$bin" ] || { echo 'kiro-cli not found after install'; exit 1; } \
 && install -m 0755 "$bin" /usr/local/bin/kiro-cli \
 && /usr/local/bin/kiro-cli --version
# The installer ran as root and left /home/agent/.local owned by root, so the
# non-root runtime user can't create kiro's local database there ("Failed to
# open database: Permission denied"). Pre-create the data/config dirs and hand
# the whole home back to the agent user.
RUN mkdir -p /home/agent/.local/share /home/agent/.config /home/agent/.kiro \
 && chown -R 10001:10001 /home/agent
USER agent
