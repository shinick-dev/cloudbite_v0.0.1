#!/bin/sh
# CloudBite computer per-user first run (user daytona, never root). Idempotent and
# non-destructive: it only creates what is missing, so settings, the browser profile and
# every tool's own sign-in persist across stop/start. No credential is created or copied.
# Safe to run again by hand to add launchers and browser routing from a newer image.
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

# The profile line must be the last line of ~/.bashrc: nvm's init above it would otherwise
# put the base image's older claude/codex ahead of the pinned ones.  Only this exact line
# is moved; the rest of ~/.bashrc is kept byte for byte (rewritten in place, same mode).
line='[ -r /etc/profile.d/cloudbite-computer.sh ] && . /etc/profile.d/cloudbite-computer.sh'
touch "$HOME/.bashrc"
if [ "$(grep -v '^[[:space:]]*$' "$HOME/.bashrc" | tail -n 1)" != "$line" ]; then
  kept=$(grep -vxF "$line" "$HOME/.bashrc" || true)
  printf '%s\n\n%s\n' "$kept" "$line" > "$HOME/.bashrc"
fi

# Native CLIs open their official OAuth pages through $BROWSER, xdg-open or XFCE's exo-open;
# route all of them to the profile browser so the redirect reaches the CLI's localhost
# callback in this VM.  A browser the user already chose for XFCE is left alone.
if ! grep -qs '^WebBrowser=' "$HOME/.config/xfce4/helpers.rc"; then
  xdg-settings set default-web-browser cloudbite-browser.desktop 2>/dev/null || true
fi
for t in x-scheme-handler/http x-scheme-handler/https text/html; do
  xdg-mime default cloudbite-browser.desktop "$t" 2>/dev/null || true
done
mkdir -p "$HOME/.config/xfce4"
grep -qs '^WebBrowser=' "$HOME/.config/xfce4/helpers.rc" ||
  printf '\nWebBrowser=cloudbite-browser\n' >>"$HOME/.config/xfce4/helpers.rc"

printf '{"schema": 1, "completed": true}\n' > "$HOME/.config/cloudbite/first-run.json"
echo '{"ok": true}'
