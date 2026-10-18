#!/bin/sh
# CloudBite computer: /usr/local/bin/xfce4-terminal. Panel, menu and launcher terminals
# start from the desktop session, whose environment predates the pinned tools (old nvm
# PATH first, SHELL unset), and xfce4-terminal's default child is then a /bin/sh that
# never reads ~/.bashrc. This wrapper loads the CloudBite profile, sets the input method,
# and opens the CloudBite shell when no command was given. Arguments are passed through
# unchanged and never evaluated; an explicit -e/--command/-x/--execute is kept as is.
real="${CLOUDBITE_TERMINAL_REAL:-/usr/bin/xfce4-terminal}"
profile="${CLOUDBITE_PROFILE:-/etc/profile.d/cloudbite-computer.sh}"
shell="${CLOUDBITE_SHELL:-/opt/cloudbite/computer/bin/cloudbite-shell}"
x11="${CLOUDBITE_X11_DIR:-/tmp/.X11-unix}"

[ -r "$profile" ] && . "$profile"
GTK_IM_MODULE=ibus; QT_IM_MODULE=ibus; XMODIFIERS=@im=ibus
export GTK_IM_MODULE QT_IM_MODULE XMODIFIERS
SHELL=/bin/bash; export SHELL

if [ -z "${DISPLAY:-}" ]; then
  for sock in "$x11"/X*; do
    [ -S "$sock" ] || continue
    DISPLAY=":${sock##*/X}"; export DISPLAY
    break
  done
fi

explicit=no
for arg in "$@"; do
  case "$arg" in
    -e|-e?*|--command|--command=*|-x|--execute) explicit=yes; break ;;
  esac
done

# --disable-server: a fresh process, so it carries this environment instead of joining
# an older terminal server started with the stale one.
if [ "$explicit" = yes ]; then
  exec "$real" --disable-server "$@"
fi
exec "$real" --disable-server "$@" -x "$shell"
