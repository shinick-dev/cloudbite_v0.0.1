#!/usr/bin/env python3
"""Fixed 1920x1080 desktop of the CloudBite computer (images/cloudbite-computer/start-desktop.py).

    python test/cloudbite-computer-display.py [SELKIES_ROOT]

SELKIES_ROOT is a directory holding the pinned ``selkies`` 2.0.0 package (an unpacked
wheel or a venv site-packages); CLOUDBITE_SELKIES_ROOT works too, and an importable
``selkies`` is used otherwise.  With it, the start script's SELKIES_* environment is
resolved by Selkies' own settings parser in a child process and the resize gates are
checked in its source.  Without it those checks are reported as skipped, never passed.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
START = os.path.join(HERE, "..", "images", "cloudbite-computer", "start-desktop.py")
INSTALL = os.path.join(HERE, "..", "images", "cloudbite-computer", "install_selkies.py")
checks = 0


def ok(cond, name):
    global checks
    if not cond:
        sys.exit("FAIL: " + name)
    checks += 1


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


start = load(START, "start_desktop")
env = start.SELKIES_ENV

# Contract: one fixed 16:9 size, server-forced and client-locked.
ok((start.WIDTH, start.HEIGHT) == (1920, 1080) and start.WIDTH * 9 == start.HEIGHT * 16, "fixed 1920x1080, 16:9")
ok(env["SELKIES_MANUAL_RESOLUTION"] == "true|locked", "manual resolution locked on")
ok(env["SELKIES_MANUAL_WIDTH"] == "1920" and env["SELKIES_MANUAL_HEIGHT"] == "1080", "manual size")
ok(env["SELKIES_ENABLE_RESIZE"] == "false|locked", "client resize locked off")
ok(env["SELKIES_FORCE_ALIGNED_RESOLUTION"] == "false|locked", "no 16px alignment (1080 would become 1088)")
ok(env["SELKIES_SECOND_SCREEN"] == "false", "no second screen widening the root")
ok(start.DISPLAY_EXPECTED == {"width": 1920, "height": 1080, "selkies_env": env}, "display config records the settings")
ok("selkies.display_utils" in open(INSTALL).read(), "installer verifies the RandR helper imports")


# fix_size: runs the pinned helper with the fixed size, parses its printed tuple only.
def fake_run(stdout, raises=None):
    calls = []

    def run(argv, **kw):
        calls.append((argv, kw))
        if raises:
            raise raises
        return types.SimpleNamespace(returncode=0, stdout=stdout, stderr="")
    return run, calls


real_run = start.subprocess.run
try:
    run, calls = fake_run("INFO noise\n(1920, 1080)\n")
    start.subprocess.run = run
    ok(start.fix_size("/v/bin/python", {"DISPLAY": ":0"}) == "1920x1080", "realized size parsed")
    ok(calls[0][0] == ["/v/bin/python", "-m", "selkies.display_utils", "1920x1080"], "helper argv")
    ok(calls[0][1]["env"] == {"DISPLAY": ":0"} and calls[0][1]["timeout"] == 30, "helper env and bound")
    ok(calls[0][1]["cwd"] == start.BASE, "helper runs from the private base, not the caller's cwd")
    start.subprocess.run = fake_run("(1928, 1080)\n")[0]
    ok(start.fix_size("p", {}) == "1928x1080", "realized size reported as realized, not as requested")
    start.subprocess.run = fake_run("None\n")[0]
    ok(start.fix_size("p", {}) is None, "refused size is None")
    start.subprocess.run = fake_run("")[0]
    ok(start.fix_size("p", {}) is None, "no output is None")
    start.subprocess.run = fake_run("", subprocess.TimeoutExpired("p", 30))[0]
    ok(start.fix_size("p", {}) is None, "timeout is None")
finally:
    start.subprocess.run = real_run

# display_config: only the exact recorded settings count as current.
with tempfile.TemporaryDirectory() as tmp:
    start.DISPLAY_CONFIG = os.path.join(tmp, "selkies-display.json")
    ok(start.display_config() == "stale", "missing record is stale")
    with open(start.DISPLAY_CONFIG, "w") as fh:
        json.dump(start.DISPLAY_EXPECTED, fh)
    ok(start.display_config() == "current", "matching record is current")
    with open(start.DISPLAY_CONFIG, "w") as fh:
        json.dump(dict(start.DISPLAY_EXPECTED, width=1024), fh)
    ok(start.display_config() == "stale", "other size is stale")
    with open(start.DISPLAY_CONFIG, "w") as fh:
        fh.write("{")
    ok(start.display_config() == "stale", "corrupt record is stale")

# Selkies' own parser on the exact environment.
root = (sys.argv[1:] or [os.environ.get("CLOUDBITE_SELKIES_ROOT", "")])[0]
locate = ("import importlib.util,sys;s=importlib.util.find_spec('selkies');"
          "print(s.submodule_search_locations[0] if s else '')")
child_env = {k: v for k, v in os.environ.items() if not k.startswith("SELKIES_")}
child_env.update(env)
child_env["PYTHONPATH"] = root
pkg = subprocess.run([sys.executable, "-c", locate], env=child_env, capture_output=True, text=True).stdout.strip()
if not pkg:
    print("SKIP: no selkies package (pass SELKIES_ROOT); Selkies parse and gate checks not run")
    print("PASS %d checks (Selkies checks skipped)" % checks)
    sys.exit(0)

probe = r"""
import json, sys
sys.argv = ['selkies']
from selkies import settings as s
p = s.build_client_settings_payload()
print(json.dumps({
    'manual_resolution': list(s.settings.manual_resolution),
    'manual_width': s.settings.manual_width, 'manual_height': s.settings.manual_height,
    'enable_resize': list(s.settings.enable_resize),
    'force_aligned_resolution': list(s.settings.force_aligned_resolution),
    'second_screen': list(s.settings.second_screen),
    'payload': {k: p.get(k) for k in ('manual_resolution', 'manual_width', 'manual_height', 'enable_resize')},
}))
"""
out = subprocess.run([sys.executable, "-c", probe], env=child_env, capture_output=True, text=True)
ok(out.returncode == 0, "selkies settings parse the environment: " + out.stderr[-400:])
got = json.loads(out.stdout.strip().splitlines()[-1])
ok(got["manual_resolution"] == [True, True], "parsed manual resolution on, locked")
ok((got["manual_width"], got["manual_height"]) == (1920, 1080), "parsed manual 1920x1080")
ok(got["enable_resize"] == [False, True], "parsed resize off, locked")
ok(got["force_aligned_resolution"] == [False, True], "parsed alignment off, locked")
ok(got["second_screen"][0] is False, "parsed second screen off")
ok(got["payload"]["manual_resolution"] == {"value": True, "locked": True, "overridden": True}, "client told manual is locked")
ok(got["payload"]["enable_resize"]["value"] is False and got["payload"]["enable_resize"]["locked"], "client told resize is locked off")
ok(got["payload"]["manual_width"]["value"] == 1920 and got["payload"]["manual_height"]["value"] == 1080, "client told the size")


# The pinned server's gates this configuration relies on (guards a Selkies upgrade).
def src(name):
    with open(os.path.join(pkg, name), encoding="utf-8") as fh:
        return fh.read()


ws, du = src("websockets_mode.py"), src("display_utils.py")
ok("server is in manual resolution mode. Request ignored." in ws, "client resize ignored under manual mode")
ok("Server override: Applying manual resolution" in ws, "server size forced on client settings")
ok("dynamic resizing disabled" in ws, "enable_resize gate present")
ok('if __name__ == "__main__":\n    entrypoint()' in du and "print(await resize_display(res))" in du,
   "display_utils runs as the resize CLI and prints the realized size")
ok("conn.set_close_down_mode(x11_X.RetainTemporary)" in du, "helper mode outlives the helper process")
print("PASS %d checks (selkies at %s)" % (checks, pkg))
