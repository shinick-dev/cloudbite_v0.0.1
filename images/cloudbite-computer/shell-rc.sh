# CloudBite computer: rc file for cloudbite-shell (installed in /opt/cloudbite/computer/lib).
# The owner's ~/.bashrc runs unchanged (aliases, prompt, history settings), then the
# CloudBite profile so the pinned tools and the shared session bus come first in PATH.
# It only reads files; nothing here signs in, stores a secret or replaces a tool.
[ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"
[ -r "${CLOUDBITE_PROFILE:-/etc/profile.d/cloudbite-computer.sh}" ] && . "${CLOUDBITE_PROFILE:-/etc/profile.d/cloudbite-computer.sh}"
hash -r
