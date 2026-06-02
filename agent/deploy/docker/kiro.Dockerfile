# kiro-cli harness image = base runner + the kiro-cli CLI.
# kiro authenticates to its own backend via KIRO_API_KEY (injected at runtime).
#
#   docker buildx build --platform linux/amd64 \
#     -f deploy/docker/kiro.Dockerfile -t <repo>:kiro --build-arg BASE=triage-base agent
ARG BASE=triage-base
FROM ${BASE}

USER root
# The installer drops the binary in ~/.local/bin (= /root/.local/bin as root);
# relocate onto a system PATH so the non-root runtime user can exec it. Fail the
# build if it's not found, rather than shipping a broken image.
RUN curl -fsSL https://cli.kiro.dev/install | bash \
 && bin="$(find /root/.local/bin -name kiro-cli -type f 2>/dev/null | head -n1)" \
 && [ -n "$bin" ] && install -m 0755 "$bin" /usr/local/bin/kiro-cli \
 && /usr/local/bin/kiro-cli --version
USER triage
