#!/bin/sh
# CloudBite computer: /opt/cloudbite/computer/bin/cloudbite-shell. An interactive bash
# whose rc file reads the owner's ~/.bashrc first and the CloudBite profile last.
exec "${CLOUDBITE_BASH:-/bin/bash}" --rcfile "${CLOUDBITE_SHELL_RC:-/opt/cloudbite/computer/lib/shell-rc.sh}" -i "$@"
