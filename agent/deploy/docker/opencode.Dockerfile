# opencode harness image = base runner + the opencode CLI.
# opencode authenticates via provider env vars / auth.json (set at runtime).
#
#   docker buildx build --platform linux/amd64 \
#     -f deploy/docker/opencode.Dockerfile -t <repo>:opencode --build-arg BASE=triage-base agent
ARG BASE=triage-base
FROM ${BASE}

USER root
# Installer drops the binary in ~/.opencode/bin or ~/.local/bin; relocate onto a
# system PATH for the non-root user. Fail the build if not found.
RUN curl -fsSL https://opencode.ai/install | bash \
 && bin="$(find /root/.opencode/bin /root/.local/bin -name opencode -type f 2>/dev/null | head -n1)" \
 && [ -n "$bin" ] && install -m 0755 "$bin" /usr/local/bin/opencode \
 && /usr/local/bin/opencode --version
USER app
