# CloudBite personal computer image: the Daytona CPU base (which already carries the
# computer_use Xvfb/xfce/noVNC stack) plus Selkies 2.0.0, Chromium with a persistent
# per-user profile, a per-user DBus/keyring session and the official native agent CLIs.
#
# Every download is pinned by version and checked against a recorded digest inside
# install.py / install_selkies.py; nothing is piped into a shell, at build or at runtime.
# The image carries apps and runtimes only: no credential, token, API key or login state.
# Users sign in with each tool's own official flow inside the desktop after first open.
#
# Build (root builds the Daytona snapshot; no cloud action happens in this file):
#   docker build -t cloudbite-computer:1 images/cloudbite-computer
# Pin BASE_IMAGE by digest when building for release:
#   --build-arg BASE_IMAGE=daytonaio/sandbox@sha256:<digest>
# Snapshot resources: 4 vCPU, 8 GiB memory, 10 GiB disk.
#
# Runtime (as user daytona, never root), after the SDK computer_use.start():
#   /opt/cloudbite/computer/bin/cloudbite-start-desktop
# Its last stdout line is one JSON object, {"ok": true, ...} or {"ok": false, "code": "computer_..."}.
ARG BASE_IMAGE=daytonaio/sandbox:0.9.0
FROM ${BASE_IMAGE}

USER root
ENV VNC_RESOLUTION=1920x1080
ENV PATH=/opt/cloudbite/computer/tools:/opt/cloudbite/node/bin:${PATH}
ENV BROWSER=/usr/local/bin/cloudbite-browser
ENV SHELL=/bin/bash GTK_IM_MODULE=ibus QT_IM_MODULE=ibus XMODIFIERS=@im=ibus
COPY install_selkies.py install.py start-desktop.py probe-tools.py first-run.sh configure-display.py keyring-default.py configure-input.py terminal-wrapper.sh shell.sh shell-rc.sh /tmp/cloudbite-computer/
RUN python3 /tmp/cloudbite-computer/install_selkies.py /opt/cloudbite/selkies \
 && test -f /opt/cloudbite/selkies/.cloudbite-selkies.json \
 && python3 /tmp/cloudbite-computer/configure-display.py \
 && python3 /tmp/cloudbite-computer/install.py /tmp/cloudbite-computer \
 && localedef -i ko_KR -f UTF-8 ko_KR.UTF-8 \
 && rm -rf /tmp/cloudbite-computer \
 && chmod -R a+rX /opt/cloudbite
USER daytona
