"""Install pinned Selkies 2.0.0 into a private virtualenv.

Single source for both paths:
- run inside the desktop sandbox by ``cloudbite/desktop.py`` (``python3 -c``),
- run at image build time by ``images/selkies/Dockerfile`` to prebake
  ``/opt/cloudbite/selkies``.

Usage: ``python3 install_selkies.py DEST [PREPARED ...]``.  A PREPARED root
(or DEST) that already carries a valid marker for this exact version and wheel
hash is reused.  Otherwise DEST is rebuilt: ``pip download`` the selkies wheel
alone, verify its sha256, then ``pip install`` that file plus the pinned
native capture/encode wheels.  Binary wheels only (no source builds).  The last
stdout line is one JSON object: ``{"ok": true, "python": ..., "cached": bool}``
or ``{"ok": false, "code": "desktop_selkies_..."}``.  No secret is ever used.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

VERSION = "2.0.0"
WHEEL = "selkies-2.0.0-py3-none-any.whl"
WHEEL_SHA256 = "f2777e74d191e2b5063190d40bfc6df00d7a77930620e0048a79267f211cbead"
PINS = ("pixelflux==2.1.0", "pcmflux==2.1.0")
MARKER = ".cloudbite-selkies.json"
STEP_TIMEOUT_S = 150


def emit(obj):
    sys.stdout.write("\n" + json.dumps(obj) + "\n")
    sys.stdout.flush()


def fail(code):
    emit({"ok": False, "code": code})
    sys.exit(0)


def digest(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def run(argv, timeout=STEP_TIMEOUT_S):
    try:
        return subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, timeout=timeout).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def verified(python):
    probe = ("import importlib.metadata as m, selkies, pixelflux, pcmflux;"
             "print(m.version('selkies'))")
    try:
        out = subprocess.run([python, "-c", probe], stdin=subprocess.DEVNULL, capture_output=True,
                             text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return False
    return out.returncode == 0 and out.stdout.strip().splitlines()[-1:] == [VERSION]


def ready(root):
    """The venv python of ``root`` when its marker names this exact pin and it imports."""
    python = os.path.join(root, "bin", "python")
    try:
        with open(os.path.join(root, MARKER)) as fh:
            marker = json.load(fh)
    except (OSError, ValueError):
        return None
    ok = (isinstance(marker, dict) and marker.get("version") == VERSION
          and marker.get("wheel_sha256") == WHEEL_SHA256 and marker.get("pins") == list(PINS)
          and not os.path.islink(root) and os.path.isdir(root) and os.path.exists(python))
    return python if ok and verified(python) else None


def install(dest):
    shutil.rmtree(dest, ignore_errors=True)
    parent = os.path.dirname(dest.rstrip("/")) or "/"
    os.makedirs(parent, exist_ok=True)
    if not run([sys.executable, "-m", "venv", dest]):
        fail("desktop_selkies_venv_failed")
    python = os.path.join(dest, "bin", "python")
    pip = [python, "-m", "pip", "--disable-pip-version-check", "--no-input", "-q"]
    staging = tempfile.mkdtemp(prefix="selkies-wheel-", dir=parent)
    try:
        if not run(pip + ["download", "--no-deps", "--only-binary=:all:", "-d", staging,
                          "selkies==" + VERSION]):
            fail("desktop_selkies_download_failed")
        wheel = os.path.join(staging, WHEEL)
        if not os.path.isfile(wheel) or os.path.islink(wheel) or digest(wheel) != WHEEL_SHA256:
            fail("desktop_selkies_hash_mismatch")
        if not run(pip + ["install", "--only-binary=:all:", wheel, *PINS]):
            fail("desktop_selkies_install_failed")
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    if not verified(python):
        fail("desktop_selkies_verify_failed")
    with open(os.path.join(dest, MARKER), "w") as fh:
        json.dump({"version": VERSION, "wheel_sha256": WHEEL_SHA256, "pins": list(PINS)}, fh)
    return python


def main(argv):
    if sys.version_info < (3, 10):
        fail("desktop_selkies_python_unsupported")
    roots = [r for r in argv[1:] if r.startswith("/") and ".." not in r.split("/")]
    if not roots or len(roots) != len(argv) - 1:
        fail("desktop_selkies_invalid_root")
    dest, prepared = roots[0], roots[1:]
    for root in prepared + [dest]:
        python = ready(root)
        if python:
            emit({"ok": True, "python": python, "cached": True, "prepared": root != dest})
            return
    emit({"ok": True, "python": install(dest), "cached": False, "prepared": False})


if __name__ == "__main__":
    main(sys.argv)
