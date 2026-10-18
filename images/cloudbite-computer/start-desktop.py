#!/usr/bin/env python3
"""Start the CloudBite computer session for the user daytona (never root).

Run by the control plane after the SDK ``computer_use.start()`` has brought up the X
display and XFCE.  Idempotent: a second run reuses a healthy Selkies and live session bus.

1. per-user first-run (profile dirs, launchers, default browser) unless already done;
2. a per-user DBus session bus at /tmp/cloudbite-dbus-<uid>/bus, shared with shells via
   /etc/profile.d/cloudbite-computer.sh;
3. gnome-keyring (secrets) on that bus, so Chromium and native CLIs keep their own
   OAuth tokens in the user's keyring.  The login keyring has an empty password: its
   protection is the private sandbox filesystem, not a passphrase;
4. a fixed 1920x1080 desktop, sized with the pinned Selkies' own RandR helper before
   Selkies starts, so the desktop has that size even with no client connected;
5. Selkies 2.0.0 (websocket, CPU H.264, no basic auth) on port 8082 under the subfolder
   /p/_cloudbite/computer/desktop, ready only after its HTTP health answers ``OK``.  Its
   manual resolution is locked to the same size and client resizing is locked off, so no
   phone or browser window resizes the desktop; the web client letterboxes the 16:9
   stream into whatever viewport it has.  A Selkies already running with other settings
   is reused but reported as ``"display_config": "stale"`` (it needs a restart).

The last stdout line is one JSON object, ``{"ok": true, ...}`` or
``{"ok": false, "code": "computer_..."}``.  No credential or environment secret is read.
"""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

PORT = 8082
PREFIX = "/p/_cloudbite/computer/desktop"
BASE = "/tmp/cloudbite-computer"
SELKIES_INSTALLER = "/opt/cloudbite/computer/lib/install_selkies.py"
SELKIES_PREPARED = "/opt/cloudbite/selkies"
FIRST_RUN = "/opt/cloudbite/computer/bin/cloudbite-first-run"
HEALTH_S = 65
WIDTH, HEIGHT = 1920, 1080
DISPLAY_CONFIG = BASE + "/selkies-display.json"
# Same documented SELKIES_<NAME> settings as cloudbite/desktop.py, under the computer subfolder.
SELKIES_ENV = {
    "SELKIES_MODE": "websockets", "SELKIES_ENABLE_DUAL_MODE": "false",
    "SELKIES_ENABLE_HTTPS": "false", "SELKIES_ENABLE_BASIC_AUTH": "false",
    "SELKIES_ADDR": "0.0.0.0", "SELKIES_PORT": str(PORT), "SELKIES_SUBFOLDER": PREFIX,
    "SELKIES_ENCODER": "h264enc", "SELKIES_USE_CPU": "true",
    "SELKIES_AUDIO_ENABLED": "false", "SELKIES_MICROPHONE_ENABLED": "false",
    "SELKIES_WEBCAM_ENABLED": "false", "SELKIES_GAMEPAD_ENABLED": "false",
    "SELKIES_COMMAND_ENABLED": "false", "SELKIES_ENABLE_METRICS_HTTP": "false",
    # Fixed desktop: the server applies this size on every connection and ignores client
    # resize requests; "|locked" keeps clients from switching either back.  No second
    # screen, which would widen the X root beyond the fixed size.
    "SELKIES_MANUAL_RESOLUTION": "true|locked", "SELKIES_MANUAL_WIDTH": str(WIDTH),
    "SELKIES_MANUAL_HEIGHT": str(HEIGHT), "SELKIES_ENABLE_RESIZE": "false|locked",
    "SELKIES_FORCE_ALIGNED_RESOLUTION": "false|locked", "SELKIES_SECOND_SCREEN": "false",
}
DISPLAY_EXPECTED = {"width": WIDTH, "height": HEIGHT, "selkies_env": SELKIES_ENV}


def emit(obj):
    sys.stdout.write("\n" + json.dumps(obj) + "\n")
    sys.stdout.flush()


def fail(code):
    emit({"ok": False, "code": code})
    sys.exit(0)


def last_json(text):
    for line in reversed(text.strip().splitlines()):
        try:
            value = json.loads(line)
        except ValueError:
            continue
        return value if isinstance(value, dict) else None
    return None


def healthy():
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d%s/api/health" % (PORT, PREFIX), timeout=2) as r:
            return r.status == 200 and r.read(16).strip() == b"OK"
    except Exception:
        return False


def displays():
    try:
        names = os.listdir("/tmp/.X11-unix")
    except OSError:
        return []
    return sorted(int(n[1:]) for n in names if n[:1] == "X" and n[1:].isdigit())


def bus_alive(path):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(1)
    try:
        s.connect(path)
        return True
    except OSError:
        return False
    finally:
        s.close()


def start_bus(env):
    folder = "/tmp/cloudbite-dbus-%d" % os.getuid()
    path = folder + "/bus"
    os.makedirs(folder, mode=0o700, exist_ok=True)
    if os.stat(folder).st_uid != os.getuid() or os.path.islink(folder):
        fail("computer_dbus_dir_untrusted")
    os.chmod(folder, 0o700)
    env["XDG_RUNTIME_DIR"] = folder
    if not bus_alive(path):
        if os.path.exists(path):
            os.remove(path)
        subprocess.Popen(["dbus-daemon", "--session", "--nofork", "--nopidfile", "--address=unix:path=" + path],
                         env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
        deadline = time.monotonic() + 10
        while not bus_alive(path):
            if time.monotonic() > deadline:
                fail("computer_dbus_start_failed")
            time.sleep(0.2)
    return "unix:path=" + path


def start_keyring(env):
    """Unlock (creating on first use) the login keyring; best effort, reported honestly."""
    env.pop("GNOME_KEYRING_CONTROL", None)
    for args in (["--unlock", "--components=secrets"], ["--start", "--components=secrets"]):
        try:
            # Daemon children can keep captured pipes open after their parent exited.
            # No exported variable is needed: the applications all use this same bus.
            subprocess.run(["gnome-keyring-daemon"] + args, input=b"", env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        except (OSError, subprocess.SubprocessError):
            pass
    # Starting the daemon alone does not create a default collection. Chromium otherwise
    # blocks on a new-keyring password dialog before even issuing a localhost callback.
    for _ in range(4):
        try:
            ready = subprocess.run(["/usr/bin/python3", "/opt/cloudbite/computer/lib/keyring-default.py"],
                                   env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=5)
            if (last_json(ready.stdout) or {}).get("ok"):
                return "started"
        except (OSError, subprocess.SubprocessError):
            pass
        time.sleep(0.25)
    return "unavailable"


def fix_size(python, env):
    """Size the X screen with the pinned Selkies' RandR helper (its ``selkies-resize``).

    The helper's X connection retains the mode after it exits and Selkies adopts it on
    start.  Returns the realized ``"WxH"``, or None when the X server refused the size.
    """
    try:
        out = subprocess.run([python, "-m", "selkies.display_utils", "%dx%d" % (WIDTH, HEIGHT)], env=env,
                             stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30, cwd=BASE)
    except (OSError, subprocess.SubprocessError):
        return None
    line = (out.stdout.strip().splitlines() or [""])[-1].strip("() ").split(", ")
    return "%sx%s" % tuple(line) if len(line) == 2 and all(p.isdigit() for p in line) else None


def display_config():
    try:
        with open(DISPLAY_CONFIG) as fh:
            return "current" if json.load(fh) == DISPLAY_EXPECTED else "stale"
    except (OSError, ValueError):
        return "stale"


def main():
    if os.geteuid() == 0:
        fail("computer_start_as_root")
    home = os.path.expanduser("~")
    os.makedirs(BASE, mode=0o700, exist_ok=True)
    env = dict(os.environ)
    env["PATH"] = home + "/.local/bin:/opt/cloudbite/computer/bin:" + env.get("PATH", "/usr/bin:/bin")
    deadline = time.monotonic() + 15
    while not displays():
        if time.monotonic() > deadline:
            fail("computer_no_display")
        time.sleep(0.5)
    env["DISPLAY"] = ":%d" % displays()[0]
    env["DBUS_SESSION_BUS_ADDRESS"] = start_bus(env)
    keyring = start_keyring(env)
    env.update(GTK_IM_MODULE="ibus", QT_IM_MODULE="ibus", XMODIFIERS="@im=ibus")
    try:
        im = subprocess.run(["/usr/bin/python3", "/opt/cloudbite/computer/lib/configure-input.py"],
                            env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
        input_method = last_json(im.stdout) or {"ok": False}
    except (OSError, subprocess.SubprocessError):
        input_method = {"ok": False}
    if not os.path.exists(home + "/.config/cloudbite/first-run.json"):
        try:
            ok = subprocess.run([FIRST_RUN], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=60).returncode == 0
        except (OSError, subprocess.SubprocessError):
            ok = False
        if not ok:
            fail("computer_first_run_failed")
    resolution = None
    if not healthy():
        try:
            out = subprocess.run([sys.executable, SELKIES_INSTALLER, BASE + "/selkies-venv", SELKIES_PREPARED],
                                 stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=200)
        except (OSError, subprocess.SubprocessError):
            fail("computer_selkies_install_timeout")
        result = last_json(out.stdout) or {}
        python = result.get("python")
        if not result.get("ok") or python not in (BASE + "/selkies-venv/bin/python", SELKIES_PREPARED + "/bin/python"):
            fail("computer_selkies_install_failed")
        resolution = fix_size(python, env)
        try:
            os.remove(DISPLAY_CONFIG)
        except OSError:
            pass
        log = open(os.path.join(BASE, "selkies.log"), "ab")
        proc = subprocess.Popen([python, "-m", "selkies"], env=dict(env, **SELKIES_ENV), stdin=subprocess.DEVNULL,
                                stdout=log, stderr=log, start_new_session=True, cwd=BASE)
        deadline = time.monotonic() + HEALTH_S
        while not healthy():
            if proc.poll() is not None:
                fail("computer_selkies_exited")
            if time.monotonic() > deadline:
                fail("computer_selkies_health_timeout")
            time.sleep(0.5)
        with open(DISPLAY_CONFIG, "w") as fh:
            json.dump(DISPLAY_EXPECTED, fh)
    emit({"ok": True, "display": env["DISPLAY"], "keyring": keyring, "port": PORT,
          "health": PREFIX + "/api/health", "size": "%dx%d" % (WIDTH, HEIGHT),
          "resolution": resolution, "display_config": display_config(), "input_method": input_method})


if __name__ == "__main__":
    main()
