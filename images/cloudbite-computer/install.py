"""Build-time installer for the CloudBite computer image (run as root by the Dockerfile).

Usage: ``python3 install.py SRC`` where SRC holds start-desktop.py, probe-tools.py and
first-run.sh.  Steps, each bounded by a timeout:

1. apt (``--no-install-recommends``): Chromium, DBus, gnome-keyring, libsecret, xdg-utils.
   Debian only: Ubuntu ships Chromium as a snap, which a container cannot run, so the
   build fails with ``computer_chromium_unsupported_os`` instead of installing a stub.
2. Node.js 22 from the nodejs.org release tarball, sha256 checked, into /opt/cloudbite/node.
   The npm CLIs run on this Node through wrappers, whatever Node the base image carries.
3. Official npm packages at exact versions: Claude Code, Codex, OpenCode.
4. Cursor Agent and Antigravity ``agy`` from the exact tarballs their official installers
   download (https://cursor.com/install, https://antigravity.google/cli/install.sh),
   checked against the digest recorded here instead of running those scripts.
5. Fixed scripts, the Chromium wrapper, desktop launchers and the image manifest.

Chromium, DBus, keyring, Node and npm are required: any failure aborts the build.  The
agent CLIs in REQUIRED_TOOLS are required too: every step is attempted, the manifest
records each outcome with a fixed code, and the build then fails closed with
``computer_required_tools_missing`` if any of them lacks a passing ``--version``, so an
image with missing CLIs is never shipped.  Steps print one JSON diagnostic line each
(fixed argv, exit code, digest outcome).  No credential, token, environment secret or auth
state is read or written, and the throwaway build HOME is removed.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request

ROOT = "/opt/cloudbite/computer"
BIN = ROOT + "/bin"
NODE_DIR = "/opt/cloudbite/node"
NPM_PREFIX = "/opt/cloudbite/npm"
STEP_TIMEOUT_S = 600
FETCH_ATTEMPTS = 3
# downloads.cursor.com answers 403 to urllib's default "Python-urllib/x" agent.
USER_AGENT = "cloudbite-computer-install/1"
REQUIRED_TOOLS = ("claude-code", "codex", "opencode", "cursor-agent", "antigravity")
# Python's own extraction filter where available (3.12+, backported to 3.8.17+); extract()
# applies its own containment checks either way.
TAR_FILTER = {"filter": "data"} if hasattr(tarfile, "data_filter") else {}

APT_PACKAGES = ("chromium", "dbus", "dbus-x11", "gnome-keyring", "libsecret-1-0",
                "xdg-utils", "ca-certificates", "xz-utils")

NODE = {
    "version": "22.20.0",
    "url": "https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz",
    "sha256": "00bbd05e306ea68b6e13e17360d0e2f680b493ef95f2fea1c4296ff7437530bc",
}

# id -> npm package, exact version, executable inside NPM_PREFIX/bin.
NPM_TOOLS = (
    ("claude-code", "@anthropic-ai/claude-code", "2.1.302", "claude"),
    ("codex", "@openai/codex", "0.163.0", "codex"),
    ("opencode", "opencode-ai", "1.19.3", "opencode"),
)

CURSOR = {
    "id": "cursor-agent", "version": "2026.10.16-e3cb207",
    "url": "https://downloads.cursor.com/lab/2026.10.16-e3cb207/linux/x64/agent-cli-package.tar.gz",
    "sha256": "3aa3f48cd7a3909a98c9b3f2a4085f0c021088bf826690b22c61f424c843e552",
}
ANTIGRAVITY = {
    "id": "antigravity", "version": "1.4.2",
    "url": ("https://storage.googleapis.com/antigravity-public/antigravity-cli/"
            "1.4.2-4835981233356800/linux-x64/cli_linux_x64.tar.gz"),
    "sha512": ("4a393afc1369cee94e817c1b430c9128d02b12ebd4d5703ace5cd47b2333e216"
               "d673fb0097cbf7195f757b110163ba9850e9eea3fdbbaddd4b25668b82c03f05"),
}

# Desktop web launchers (id, name, https URL); src/cloudbite-computer-tools.ts lists the same set.
WEB_APPS = (
    ("grok", "Grok", "https://grok.com/"),
    ("genspark", "Genspark", "https://www.genspark.ai/"),
    ("lovable", "Lovable", "https://lovable.dev/"),
    ("chatgpt", "ChatGPT", "https://chatgpt.com/"),
    ("claude-web", "Claude", "https://claude.ai/"),
    ("antigravity-web", "Google Antigravity", "https://antigravity.google/"),
    ("openrouter", "OpenRouter", "https://openrouter.ai/"),
    ("tavily", "Tavily", "https://app.tavily.com/"),
    ("elevenlabs", "ElevenLabs", "https://elevenlabs.io/"),
    ("nebius", "Nebius Token Factory", "https://tokenfactory.nebius.com/"),
    ("daytona", "Daytona", "https://app.daytona.io/"),
    ("nosana", "Nosana", "https://dashboard.nosana.com/"),
    ("k-broker", "k broker", "https://k.shinick.dev/borrow"),
)

PROFILE_SH = """\
# CloudBite computer: pinned runtimes and per-user session bus (no secrets here).
case ":$PATH:" in *":/opt/cloudbite/computer/bin:"*) ;; *)
  PATH="$HOME/.local/bin:/opt/cloudbite/computer/bin:$PATH"; export PATH ;;
esac
export DISABLE_AUTOUPDATER=1
export BROWSER=/usr/local/bin/cloudbite-browser
if [ -z "$DBUS_SESSION_BUS_ADDRESS" ] && [ -S "/tmp/cloudbite-dbus-$(id -u)/bus" ]; then
  DBUS_SESSION_BUS_ADDRESS="unix:path=/tmp/cloudbite-dbus-$(id -u)/bus"; export DBUS_SESSION_BUS_ADDRESS
fi
"""

# No --no-sandbox: Chromium keeps its sandbox; if the container forbids it, the browser
# fails visibly and start-desktop reports it instead of silently weakening isolation.
BROWSER_SH = """\
#!/bin/sh
. /etc/profile.d/cloudbite-computer.sh
exec /usr/bin/chromium --user-data-dir="$HOME/.config/cloudbite-browser" \\
  --password-store=gnome-libsecret --no-first-run --no-default-browser-check "$@"
"""

WRAPPER_SH = """\
#!/bin/sh
PATH="/opt/cloudbite/node/bin:$PATH" exec "/opt/cloudbite/npm/bin/{exe}" "$@"
"""


def emit(obj):
    sys.stdout.write("\n" + json.dumps(obj) + "\n")
    sys.stdout.flush()


def die(code):
    emit({"ok": False, "code": code})
    sys.exit(1)


def run(argv, env=None, timeout=STEP_TIMEOUT_S, step=None):
    """Run a fixed argv (pinned package names and paths only, never secrets)."""
    try:
        rc = subprocess.run(argv, stdin=subprocess.DEVNULL, env=env, timeout=timeout).returncode
    except subprocess.TimeoutExpired:
        rc = "timeout"
    except (OSError, subprocess.SubprocessError) as exc:
        rc = type(exc).__name__
    if step:
        emit({"step": step, "argv": argv, "rc": rc})
    return rc == 0


def fetch(url, dest, algo, expected, step="fetch", opener=None):
    """Stream url to dest.  Returns None when the digest matches, else a fixed reason.

    Network and HTTP errors are retried up to FETCH_ATTEMPTS times; a digest mismatch is
    never retried or accepted.
    """
    if not url.startswith("https://"):
        return "not_https"
    opener = opener or urllib.request.urlopen
    reason = "unattempted"
    for attempt in range(1, FETCH_ATTEMPTS + 1):
        h = hashlib.new(algo)
        size = 0
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with opener(req, timeout=120) as r, open(dest, "wb") as fh:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    h.update(chunk)
                    size += len(chunk)
                    fh.write(chunk)
        except OSError as exc:
            reason = "http_%d" % exc.code if isinstance(exc, urllib.error.HTTPError) else "network"
            emit({"step": step, "attempt": attempt, "result": reason})
            continue
        digest = h.hexdigest()
        ok = digest == expected
        emit({"step": step, "attempt": attempt, "bytes": size, "algo": algo, "digest": digest,
              "result": "ok" if ok else "digest_mismatch"})
        return None if ok else "digest_mismatch"
    return reason


def _inside(path, root):
    return path == root or path.startswith(root + os.sep)


def extract(archive, dest, strip, mode="r:*"):
    """Extract archive under dest, dropping the first ``strip`` path components.

    Relative symlinks are kept when they resolve inside dest (Node ships
    ``bin/npm -> ../lib/node_modules/npm/bin/npm-cli.js``).  A member is skipped when it is
    not a regular file, directory or link, is absolute or has a ``..`` component, would be
    written through a symlink leaving dest, would replace an existing symlink, or links
    outside dest.  Each member is checked against the disk just before it is extracted, and
    a final pass removes any symlink whose resolved target ended up outside dest.  Returns
    the number of skipped members.
    """
    os.makedirs(dest, exist_ok=True)
    root = os.path.realpath(dest)
    skipped = 0
    with tarfile.open(archive, mode) as tar:
        for m in tar.getmembers():
            parts = [p for p in m.name.split("/")[strip:] if p not in ("", ".")]
            if not parts and m.isdir():
                continue  # the stripped top-level directory itself
            if (not parts or ".." in parts or m.name.startswith("/")
                    or not (m.isfile() or m.isdir() or m.issym() or m.islnk())):
                skipped += 1
                continue
            target = os.path.join(root, *parts)
            if not _inside(os.path.realpath(os.path.dirname(target)), root) or os.path.islink(target):
                skipped += 1
                continue
            if m.issym() and (m.linkname.startswith("/") or not _inside(
                    os.path.realpath(os.path.join(os.path.dirname(target), m.linkname)), root)):
                skipped += 1
                continue
            if m.islnk():
                link_parts = [p for p in m.linkname.split("/")[strip:] if p not in ("", ".")]
                if (m.linkname.startswith("/") or not link_parts or ".." in link_parts
                        or not _inside(os.path.realpath(os.path.join(root, *link_parts)), root)):
                    skipped += 1
                    continue
                m.linkname = "/".join(link_parts)
            m.name = "/".join(parts)
            try:
                tar.extract(m, root, **TAR_FILTER)
            except (tarfile.TarError, OSError):
                skipped += 1
    for base, dirs, files in os.walk(root):
        for entry in dirs + files:
            path = os.path.join(base, entry)
            if os.path.islink(path) and not _inside(os.path.realpath(path), root):
                os.remove(path)
                skipped += 1
    return skipped


def os_id():
    try:
        with open("/etc/os-release") as fh:
            fields = dict(line.rstrip("\n").split("=", 1) for line in fh if "=" in line)
    except OSError:
        return ""
    return fields.get("ID", "").strip('"')


def version_of(argv, home):
    env = {"PATH": "/opt/cloudbite/node/bin:/usr/local/bin:/usr/bin:/bin", "HOME": home,
           "LANG": "C.UTF-8", "DISABLE_AUTOUPDATER": "1", "NO_COLOR": "1"}
    try:
        out = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                             env=env, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.search(r"\d+\.\d+[0-9A-Za-z.+-]*", out.stdout + out.stderr)
    return match.group(0)[:64] if out.returncode == 0 and match else None


def write(path, text, mode=0o644):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write(text)
    os.chmod(path, mode)


def install_apt():
    if os_id() != "debian":
        die("computer_chromium_unsupported_os")
    env = dict(os.environ, DEBIAN_FRONTEND="noninteractive")
    if not (run(["apt-get", "update"], env, step="apt-update")
            and run(["apt-get", "install", "-y", "--no-install-recommends", *APT_PACKAGES], env,
                    step="apt-install")):
        die("computer_apt_failed")
    run(["apt-get", "clean"], env, step="apt-clean")
    shutil.rmtree("/var/lib/apt/lists", ignore_errors=True)
    os.makedirs("/var/lib/apt/lists/partial", exist_ok=True)
    if not os.path.exists("/usr/bin/chromium"):
        die("computer_chromium_missing")


def ensure_node_cli_links(node_dir):
    """Pin bin/npm and bin/npx to the fixed relative targets Node's own tarball ships.

    Returns True when both target scripts exist under node_dir and the links point at them.
    """
    ok = True
    for exe, script in (("npm", "npm-cli.js"), ("npx", "npx-cli.js")):
        if not os.path.isfile(os.path.join(node_dir, "lib", "node_modules", "npm", "bin", script)):
            ok = False
            continue
        link, rel = os.path.join(node_dir, "bin", exe), "../lib/node_modules/npm/bin/" + script
        if os.path.islink(link) and os.readlink(link) == rel:
            continue
        if os.path.lexists(link):
            os.remove(link)
        os.makedirs(os.path.dirname(link), exist_ok=True)
        os.symlink(rel, link)
    return ok


def install_node(work):
    archive = os.path.join(work, "node.tar.xz")
    if fetch(NODE["url"], archive, "sha256", NODE["sha256"], step="node-fetch"):
        die("computer_node_download_failed")
    shutil.rmtree(NODE_DIR, ignore_errors=True)
    skipped = extract(archive, NODE_DIR, 1)
    os.remove(archive)
    links = ensure_node_cli_links(NODE_DIR)
    emit({"step": "node-extract", "skipped": skipped, "npm_links": links})
    if not links:
        die("computer_npm_missing")


def install_npm(tool, package, version, exe, home):
    env = dict(os.environ, PATH=NODE_DIR + "/bin:" + os.environ.get("PATH", ""), HOME=home,
               npm_config_update_notifier="false", npm_config_fund="false", npm_config_audit="false")
    ok = run([NODE_DIR + "/bin/npm", "install", "-g", "--prefix", NPM_PREFIX, f"{package}@{version}"], env,
             step=f"npm-install-{tool}")
    if ok and not os.path.isfile(f"{NPM_PREFIX}/bin/{exe}"):
        return {"code": f"computer_{tool}_bin_missing"}
    if ok:
        write(f"/usr/local/bin/{exe}", WRAPPER_SH.format(exe=exe), 0o755)
    return {"version": version, "source": f"npm:{package}@{version}"} if ok else {"code": f"computer_{tool}_install_failed"}


def install_cursor(work):
    archive = os.path.join(work, "cursor.tar.gz")
    reason = fetch(CURSOR["url"], archive, "sha256", CURSOR["sha256"], step="cursor-fetch")
    if reason:
        return {"code": "computer_cursor_digest_mismatch" if reason == "digest_mismatch"
                else "computer_cursor_download_failed"}
    dest = "/opt/cloudbite/cursor-agent/" + CURSOR["version"]
    shutil.rmtree(dest, ignore_errors=True)
    emit({"step": "cursor-extract", "skipped": extract(archive, dest, 1)})
    os.remove(archive)
    if not os.path.isfile(dest + "/cursor-agent"):
        return {"code": "computer_cursor_layout_unexpected"}
    for name in ("cursor-agent", "agent"):
        link = "/usr/local/bin/" + name
        if os.path.lexists(link):
            os.remove(link)
        os.symlink(dest + "/cursor-agent", link)
    return {"version": CURSOR["version"], "source": CURSOR["url"]}


def install_antigravity(work):
    archive = os.path.join(work, "agy.tar.gz")
    reason = fetch(ANTIGRAVITY["url"], archive, "sha512", ANTIGRAVITY["sha512"], step="antigravity-fetch")
    if reason:
        return {"code": "computer_antigravity_digest_mismatch" if reason == "digest_mismatch"
                else "computer_antigravity_download_failed"}
    dest = "/opt/cloudbite/antigravity"
    os.makedirs(dest, exist_ok=True)
    with tarfile.open(archive, "r:gz") as tar:
        member = next((m for m in tar.getmembers() if m.name == "antigravity" and m.isfile()), None)
        if member is None:
            return {"code": "computer_antigravity_layout_unexpected"}
        tar.extractall(dest, members=[member], **TAR_FILTER)
    os.remove(archive)
    os.rename(dest + "/antigravity", dest + "/agy")
    os.chmod(dest + "/agy", 0o755)
    if os.path.lexists("/usr/local/bin/agy"):
        os.remove("/usr/local/bin/agy")
    os.symlink(dest + "/agy", "/usr/local/bin/agy")
    return {"version": ANTIGRAVITY["version"], "source": ANTIGRAVITY["url"]}


def desktop_entry(name, exec_line, terminal):
    return ("[Desktop Entry]\nType=Application\nVersion=1.0\n"
            f"Name={name}\nExec={exec_line}\nTerminal={'true' if terminal else 'false'}\n"
            "Icon=applications-internet\nCategories=Network;\n")


def install_scripts(src):
    os.makedirs(BIN, exist_ok=True)
    for name, target in (("start-desktop.py", "cloudbite-start-desktop"),
                         ("probe-tools.py", "cloudbite-probe-tools"),
                         ("first-run.sh", "cloudbite-first-run")):
        shutil.copyfile(os.path.join(src, name), os.path.join(BIN, target))
        os.chmod(os.path.join(BIN, target), 0o755)
    os.makedirs(ROOT + "/lib", exist_ok=True)
    shutil.copyfile(os.path.join(src, "install_selkies.py"), ROOT + "/lib/install_selkies.py")
    write("/etc/profile.d/cloudbite-computer.sh", PROFILE_SH)
    with open("/etc/bash.bashrc", "a") as fh:
        fh.write("\n[ -r /etc/profile.d/cloudbite-computer.sh ] && . /etc/profile.d/cloudbite-computer.sh\n")
    write("/usr/local/bin/cloudbite-browser", BROWSER_SH, 0o755)
    write("/usr/share/applications/cloudbite-browser.desktop",
          desktop_entry("CloudBite Browser", "/usr/local/bin/cloudbite-browser %U", False)
          + "MimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;\n")
    launchers = ROOT + "/share/launchers"
    os.makedirs(launchers, exist_ok=True)
    for app_id, name, url in WEB_APPS:
        assert url.startswith("https://")
        write(f"{launchers}/web-{app_id}.desktop",
              desktop_entry(name, f"/usr/local/bin/cloudbite-browser {url}", False), 0o755)
    for exe, name in (("claude", "Claude Code"), ("codex", "Codex"), ("opencode", "OpenCode"),
                      ("cursor-agent", "Cursor Agent"), ("agy", "Antigravity CLI")):
        write(f"{launchers}/cli-{exe}.desktop",
              desktop_entry(name, f"xfce4-terminal --title '{name}' -e 'bash -lc \"{exe}; exec bash\"'", False), 0o755)


COMMANDS = {"claude-code": "claude", "codex": "codex", "opencode": "opencode",
            "cursor-agent": "cursor-agent", "antigravity": "agy"}


def verify_tools(tools, home, probe=version_of):
    """Probe each record with ``--version``; returns the REQUIRED_TOOLS that are not installed.

    ``installed`` is true only with a probe version; a failed probe gets the fixed
    ``computer_<tool>_verify_failed`` code, and a required tool absent from tools is missing.
    """
    for tool, record in tools.items():
        seen = probe(["/usr/local/bin/" + COMMANDS[tool], "--version"], home) if "code" not in record else None
        record["installed"] = bool(seen)
        record["probe_version"] = seen
        if "code" not in record and not seen:
            record["code"] = f"computer_{tool}_verify_failed"
        emit({"step": f"verify-{tool}", "installed": record["installed"], "code": record.get("code"),
              "probe_version": seen})
    return [t for t in REQUIRED_TOOLS if not tools.get(t, {}).get("installed")]


def main(argv):
    if os.geteuid() != 0 or len(argv) != 2:
        die("computer_install_usage")
    src = argv[1]
    install_apt()
    work = tempfile.mkdtemp(prefix="cloudbite-computer-")
    home = tempfile.mkdtemp(prefix="cloudbite-build-home-")
    try:
        install_node(work)
        node_version = version_of([NODE_DIR + "/bin/node", "--version"], home)
        if not node_version or int(node_version.split(".")[0]) < 20:
            die("computer_node_verify_failed")
        npm_version = version_of([NODE_DIR + "/bin/npm", "--version"], home)
        emit({"step": "npm-verify", "node": node_version, "npm": npm_version})
        if not npm_version:
            die("computer_npm_verify_failed")
        tools = {}
        for tool, package, version, exe in NPM_TOOLS:
            tools[tool] = install_npm(tool, package, version, exe, home)
        tools["cursor-agent"] = install_cursor(work)
        tools["antigravity"] = install_antigravity(work)
        missing = verify_tools(tools, home)
        install_scripts(src)
        manifest = {"schema": 1, "node": NODE["version"], "selkies": "2.0.0",
                    "chromium": version_of(["/usr/bin/chromium", "--version"], home), "tools": tools}
        write(ROOT + "/manifest.json", json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    finally:
        shutil.rmtree(work, ignore_errors=True)
        shutil.rmtree(home, ignore_errors=True)
    if missing:
        emit({"ok": False, "code": "computer_required_tools_missing",
              "missing": {t: tools.get(t, {}).get("code") for t in missing}})
        sys.exit(1)
    emit({"ok": True, "tools": {k: v["installed"] for k, v in tools.items()}})


if __name__ == "__main__":
    main(sys.argv)
