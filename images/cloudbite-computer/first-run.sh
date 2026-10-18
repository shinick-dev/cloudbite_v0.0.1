#!/bin/sh
# CloudBite computer per-user first run (user daytona, never root). Idempotent and
# non-destructive: it only creates what is missing, so settings, the browser profile and
# every tool's own sign-in persist across stop/start. No credential is created or copied.
set -eu
[ "$(id -u)" -ne 0 ] || { echo '{"ok": false, "code": "computer_first_run_as_root"}'; exit 1; }

umask 077
mkdir -p "$HOME/.config/cloudbite-browser" "$HOME/.config/cloudbite" "$HOME/.local/bin"
umask 022
mkdir -p "$HOME/Desktop" "$HOME/.local/share/applications"

for f in /opt/cloudbite/computer/share/launchers/*.desktop; do
  dest="$HOME/Desktop/$(basename "$f")"
  [ -e "$dest" ] || cp "$f" "$dest"
done

grep -qs 'cloudbite-computer.sh' "$HOME/.bashrc" ||
  printf '\n[ -r /etc/profile.d/cloudbite-computer.sh ] && . /etc/profile.d/cloudbite-computer.sh\n' >> "$HOME/.bashrc"

# Native CLIs open their official OAuth pages through xdg-open; route that to the profile browser.
xdg-settings set default-web-browser cloudbite-browser.desktop 2>/dev/null || true
for t in x-scheme-handler/http x-scheme-handler/https text/html; do
  xdg-mime default cloudbite-browser.desktop "$t" 2>/dev/null || true
done

printf '{"schema": 1, "completed": true}\n' > "$HOME/.config/cloudbite/first-run.json"
echo '{"ok": true}'
