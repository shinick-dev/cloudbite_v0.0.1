#!/usr/bin/env python3
"""Make the computer_use Xvfb start with a fixed 1920x1080 screen (run as root).

The base image's computer_use stack starts ``/usr/bin/Xvfb :0 -screen 0 1024x768x24``,
and Xvfb cannot grow its framebuffer past the start geometry, so neither RandR nor
Selkies can reach 1920x1080 afterwards.  This diverts the real binary with
``dpkg-divert --local --rename`` to /usr/bin/Xvfb.cloudbite-real and installs a small
wrapper at /usr/bin/Xvfb that rewrites screen 0's geometry to 1920x1080 (keeping the
requested depth, 24 when none) and execs the real server, so the supervisor still
manages the Xvfb process itself.  It takes effect the next time Xvfb starts.

Usage: ``python3 configure-display.py [--check | --remove]``.  Idempotent.  The last
stdout line is one JSON object, ``{"ok": true, "installed": bool, ...}`` or
``{"ok": false, "code": "computer_display_..."}``.
"""
import json
import os
import subprocess
import sys

TARGET = "/usr/bin/Xvfb"
REAL = "/usr/bin/Xvfb.cloudbite-real"
MARKER = "# cloudbite-xvfb-wrapper v1"
PYTHON = "/usr/bin/python3"
# The wrapper itself; ``rewrite`` is also what the tests exercise.
WRAPPER = '''#!%s
%s
"""Xvfb with screen 0 forced to the CloudBite computer's fixed size (configure-display.py)."""
import os
import sys

REAL = %r
GEOMETRY = "1920x1080"


def rewrite(args):
    out, i, seen = [], 0, False
    while i < len(args):
        if args[i] == "-screen" and i + 2 < len(args) and args[i + 1] == "0":
            depth = args[i + 2].split("x")[2:3] or ["24"]
            out += ["-screen", "0", GEOMETRY + "x" + depth[0]]
            seen, i = True, i + 3
            continue
        out.append(args[i])
        i += 1
    return out if seen else out + ["-screen", "0", GEOMETRY + "x24"]


if __name__ == "__main__":
    os.execv(REAL, [REAL] + rewrite(sys.argv[1:]))
''' % (PYTHON, MARKER, REAL)


def emit(obj):
    sys.stdout.write("\n" + json.dumps(obj) + "\n")
    sys.stdout.flush()


def fail(code):
    emit({"ok": False, "code": code})
    sys.exit(1)


def wrapper_text():
    try:
        with open(TARGET) as fh:
            text = fh.read(65536)
    except (OSError, UnicodeDecodeError):
        return None
    return text if MARKER.split(" v")[0] in text else None


def installed():
    return wrapper_text() == WRAPPER and os.path.isfile(REAL)


def divert(*args):
    try:
        return subprocess.run(["dpkg-divert", "--local", "--rename", "--divert", REAL, *args, TARGET],
                              stdin=subprocess.DEVNULL, capture_output=True, timeout=60).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def install():
    if installed():
        return False
    if not os.path.isfile(PYTHON):
        fail("computer_display_python_missing")
    if not os.path.isfile(REAL):
        if not os.path.isfile(TARGET) or os.path.islink(TARGET) or wrapper_text() is not None:
            fail("computer_display_xvfb_missing")
        if not divert("--add"):
            fail("computer_display_divert_failed")
    elif os.path.lexists(TARGET) and wrapper_text() is None:
        # Something other than our wrapper sits in front of a diverted Xvfb; never overwrite it.
        fail("computer_display_target_unexpected")
    tmp = TARGET + ".cloudbite-tmp"
    try:
        with open(tmp, "w") as fh:
            fh.write(WRAPPER)
        os.chmod(tmp, 0o755)
        os.replace(tmp, TARGET)
    except OSError:
        fail("computer_display_write_failed")
    return True


def remove():
    if not os.path.isfile(REAL):
        return False
    if os.path.lexists(TARGET):
        if wrapper_text() is None:
            fail("computer_display_target_unexpected")
        os.remove(TARGET)
    if not divert("--remove"):
        fail("computer_display_undivert_failed")
    return True


def main(argv):
    mode = argv[1] if len(argv) > 1 else "--install"
    if mode not in ("--install", "--check", "--remove"):
        fail("computer_display_bad_usage")
    if mode == "--check":
        emit({"ok": True, "installed": installed(), "changed": False})
        return
    if os.geteuid() != 0:
        fail("computer_display_needs_root")
    changed = remove() if mode == "--remove" else install()
    emit({"ok": True, "installed": installed(), "changed": changed, "geometry": "1920x1080"})


if __name__ == "__main__":
    main(sys.argv)
