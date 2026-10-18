"""Unit checks for the CloudBite computer sign-in path: browser routing, the browser wrapper's
display discovery, the sign-in helper and first-run.  No network, root, image build or real
CLI: fake commands stand in for chromium and the agent CLIs, and nothing reads a credential.
    python3 -I test/cloudbite-computer-login.py
Shell cases need a POSIX ``sh`` on PATH and are skipped without one.
"""
import importlib.util
import os
import shutil
import socket
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
IMAGE = os.path.join(HERE, "..", "images", "cloudbite-computer")
spec = importlib.util.spec_from_file_location("cloudbite_install", os.path.join(IMAGE, "install.py"))
install = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install)
install.emit = lambda obj: None
SH = shutil.which("sh")

PROFILE_LINE = "[ -r /etc/profile.d/cloudbite-computer.sh ] && . /etc/profile.d/cloudbite-computer.sh"
DEBIAN_HELPERS = "WebBrowser=debian-sensible-browser\nMailReader=debian-sensible-mail-reader\nTerminalEmulator=debian-x-terminal-emulator\n"


def write_exe(path, text):
    with open(path, "w", newline="\n") as fh:
        fh.write(text)
    os.chmod(path, 0o755)


def sh_path(path):
    """Path as the POSIX shell sees it (Git for Windows maps C:\\x to /c/x)."""
    path = os.path.abspath(path).replace("\\", "/")
    if os.name == "nt" and len(path) > 1 and path[1] == ":":
        path = "/" + path[0].lower() + path[2:]
    return path


class MergeSettings(unittest.TestCase):
    def test_sectionless_helpers_replaces_browser_keeps_others(self):
        out = install.merge_settings(DEBIAN_HELPERS, None, [("WebBrowser", "cloudbite-browser")])
        self.assertEqual(out, DEBIAN_HELPERS.replace("debian-sensible-browser", "cloudbite-browser"))

    def test_empty_files(self):
        self.assertEqual(install.merge_settings("", None, [("WebBrowser", "cloudbite-browser")]),
                         "WebBrowser=cloudbite-browser\n")
        self.assertEqual(install.merge_settings("", "Default Applications", [("text/html", "a.desktop")]),
                         "[Default Applications]\ntext/html=a.desktop\n")

    def test_keys_land_inside_their_section_only(self):
        text = ("[Default Applications]\napplication/pdf=evince.desktop\ntext/html=firefox.desktop\n\n"
                "[Added Associations]\ntext/html=firefox.desktop\n")
        pairs = [(t, "cloudbite-browser.desktop") for t in install.BROWSER_MIME]
        out = install.merge_settings(text, "Default Applications", pairs)
        default, added = out.split("[Added Associations]")
        self.assertIn("application/pdf=evince.desktop", default)
        for t in install.BROWSER_MIME:
            self.assertIn(t + "=cloudbite-browser.desktop", default)
        self.assertEqual(added, "\ntext/html=firefox.desktop\n")
        self.assertEqual(install.merge_settings(out, "Default Applications", pairs), out, "idempotent")

    def test_missing_section_is_appended(self):
        out = install.merge_settings("[Added Associations]\nx/y=z.desktop\n", "Default Applications",
                                     [("text/html", "cloudbite-browser.desktop")])
        self.assertEqual(out, "[Added Associations]\nx/y=z.desktop\n\n[Default Applications]\n"
                              "text/html=cloudbite-browser.desktop\n")


class Contracts(unittest.TestCase):
    def test_sign_in_runs_only_official_commands(self):
        for line in ('run "$T/claude" auth login\n', 'run "$T/codex" login\n',
                     'run "$T/codex" login --device-auth\n', 'run "$T/cursor-agent" login\n',
                     'run "$T/claude" auth status --text\n', 'run "$T/codex" login status\n',
                     'run "$T/cursor-agent" status'):
            self.assertIn(line, install.SIGN_IN_SH)
        self.assertEqual([a for _, _, a in install.SIGN_IN], ["claude", "codex", "codex-device", "cursor", "status"])

    def test_no_credential_material_is_touched(self):
        text = install.SIGN_IN_SH + install.BROWSER_SH + install.XFCE_HELPER + install.PROFILE_SH
        for needle in ("auth.json", ".credentials", "API_KEY", "OAUTH_TOKEN", "secret-tool", "keyring",
                       "--no-sandbox", "cat ", "cp "):
            self.assertNotIn(needle, text)

    def test_wrapper_keeps_profile_store_and_bus(self):
        self.assertIn('--user-data-dir="$HOME/.config/cloudbite-browser"', install.BROWSER_SH)
        self.assertIn("--password-store=gnome-libsecret", install.BROWSER_SH)
        self.assertNotIn("DBUS_SESSION_BUS_ADDRESS", install.BROWSER_SH)

    def test_helper_and_launchers_point_at_the_wrapper(self):
        self.assertIn('X-XFCE-CommandsWithParameter=/usr/local/bin/cloudbite-browser "%s";', install.XFCE_HELPER)
        self.assertIn("X-XFCE-Category=WebBrowser", install.XFCE_HELPER)
        entry = install.desktop_entry("Sign in: Codex", "xfce4-terminal -e 'x'", False)
        self.assertTrue(entry.startswith("[Desktop Entry]\n") and "Terminal=false" in entry)


class PinnedTools(unittest.TestCase):
    def test_launchers_and_helper_call_pinned_cli_by_absolute_path(self):
        self.assertEqual(install.TOOLS_DIR, "/opt/cloudbite/computer/tools")
        for exe in ("claude", "codex", "cursor-agent"):
            self.assertIn(exe, install.TOOL_EXES)
        self.assertIn("T=/opt/cloudbite/computer/tools\n", install.SIGN_IN_SH)
        self.assertIn(install.TOOLS_PATH_SH, install.PROFILE_SH)
        with open(os.path.join(IMAGE, "install.py")) as fh:
            self.assertIn('bash -lc \\"{TOOLS_DIR}/{exe}; exec bash\\"', fh.read())


@unittest.skipUnless(SH, "no POSIX sh")
class PathOrder(unittest.TestCase):
    """nvm's directory first on PATH (as seen live) must not shadow the pinned CLIs."""
    TOOLS = "/opt/cloudbite/computer/tools"
    NVM = "/usr/local/share/nvm/current/bin"

    def path_after(self, script):
        env = dict(os.environ, PATH=self.NVM + ":/usr/local/bin:" + os.environ.get("PATH", ""))
        out = subprocess.run([SH, "-c", script + 'printf %s "$PATH"\n'], env=env, stdin=subprocess.DEVNULL,
                             capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        return out.stdout.split(":")

    def test_profile_puts_tools_ahead_of_nvm(self):
        path = self.path_after(install.PROFILE_SH)
        self.assertEqual(path[0], self.TOOLS)
        self.assertLess(path.index(self.TOOLS), path.index(self.NVM))

    def test_resourcing_after_nvm_restores_order_without_duplicates(self):
        nvm = 'PATH="%s:$PATH"\n' % self.NVM
        path = self.path_after(install.PROFILE_SH + nvm + install.PROFILE_SH)
        self.assertEqual(path[:2], [self.TOOLS, self.NVM])
        path = self.path_after(install.PROFILE_SH + nvm + install.TOOLS_PATH_SH)
        self.assertEqual(path[:2], [self.TOOLS, self.NVM])
        self.assertEqual(self.path_after(install.TOOLS_PATH_SH + install.TOOLS_PATH_SH).count(self.TOOLS), 1)


@unittest.skipUnless(SH, "no POSIX sh")
class SignInHelper(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.log = os.path.join(self.dir, "argv.log")
        for exe, rc in (("claude", 0), ("codex", 3), ("cursor-agent", 0)):
            write_exe(os.path.join(self.dir, exe),
                      '#!/bin/sh\necho "%s $*" >> "%s"\nexit %d\n' % (exe, sh_path(self.log), rc))
        self.helper = os.path.join(self.dir, "cloudbite-sign-in")
        tools = "T=" + install.TOOLS_DIR + "\n"
        self.assertIn(tools, install.SIGN_IN_SH)
        write_exe(self.helper, install.SIGN_IN_SH.replace(tools, "T=" + sh_path(self.dir) + "\n"))

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_helper(self, *args):
        env = dict(os.environ, PATH=sh_path(self.dir) + ":" + os.environ.get("PATH", ""))
        env.pop("DISPLAY", None)
        return subprocess.run([SH, sh_path(self.helper), *args], stdin=subprocess.DEVNULL, env=env,
                              capture_output=True, text=True, timeout=30)

    def argv(self):
        with open(self.log) as fh:
            return fh.read().splitlines()

    def test_each_mode_runs_its_command_and_reports_exit(self):
        out = self.run_helper("codex-device")
        self.assertEqual(out.returncode, 0)
        self.assertEqual(self.argv(), ["codex login --device-auth"])
        self.assertIn("[exit 3]", out.stdout)
        self.assertIn("display=none", out.stdout)

    def test_status_runs_all_three(self):
        self.run_helper("status")
        self.assertEqual(self.argv(), ["claude auth status --text", "codex login status", "cursor-agent status"])

    def test_unknown_mode_runs_nothing(self):
        out = self.run_helper("rm")
        self.assertEqual(out.returncode, 2)
        self.assertFalse(os.path.exists(self.log))


@unittest.skipUnless(SH, "no POSIX sh")
class BrowserWrapper(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.x11 = os.path.join(self.dir, "x11")
        os.mkdir(self.x11)
        self.log = os.path.join(self.dir, "chromium.log")
        fake = os.path.join(self.dir, "chromium")
        write_exe(fake, '#!/bin/sh\necho "DISPLAY=$DISPLAY $*" > "%s"\n' % sh_path(self.log))
        self.wrapper = os.path.join(self.dir, "cloudbite-browser")
        write_exe(self.wrapper, install.BROWSER_SH.replace("/usr/bin/chromium", sh_path(fake))
                  .replace("/tmp/.X11-unix", sh_path(self.x11)))

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_wrapper(self, display=None):
        env = dict(os.environ, HOME=sh_path(self.dir))
        env.pop("DISPLAY", None)
        if display:
            env["DISPLAY"] = display
        return subprocess.run([SH, sh_path(self.wrapper), "https://example.test/oauth"], stdin=subprocess.DEVNULL,
                              env=env, capture_output=True, text=True, timeout=30)

    def test_existing_display_is_kept(self):
        self.assertEqual(self.run_wrapper(":7").returncode, 0)
        with open(self.log) as fh:
            line = fh.read()
        self.assertTrue(line.startswith("DISPLAY=:7 --user-data-dir="), line)
        self.assertTrue(line.rstrip().endswith("https://example.test/oauth"))

    def test_no_display_fails_without_launching(self):
        out = self.run_wrapper()
        self.assertEqual(out.returncode, 1)
        self.assertIn("no desktop display", out.stderr)
        self.assertFalse(os.path.exists(self.log))

    @unittest.skipUnless(os.name == "posix" and hasattr(socket, "AF_UNIX"), "needs unix sockets")
    def test_desktop_display_is_discovered(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.bind(os.path.join(self.x11, "X3"))
        try:
            self.assertEqual(self.run_wrapper().returncode, 0)
        finally:
            s.close()
        with open(self.log) as fh:
            self.assertTrue(fh.read().startswith("DISPLAY=:3 "))


@unittest.skipUnless(SH, "no POSIX sh")
class FirstRun(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.home = os.path.join(self.dir, "home")
        self.launchers = os.path.join(self.dir, "launchers")
        os.makedirs(self.home)
        os.makedirs(self.launchers)
        write_exe(os.path.join(self.launchers, "signin-codex.desktop"), "[Desktop Entry]\nName=new\n")
        with open(os.path.join(IMAGE, "first-run.sh")) as fh:
            text = fh.read()
        self.assertIn("/opt/cloudbite/computer/share/launchers", text)
        self.script = os.path.join(self.dir, "first-run")
        write_exe(self.script, text.replace("/opt/cloudbite/computer/share/launchers", sh_path(self.launchers)))

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_first(self):
        env = dict(os.environ, HOME=sh_path(self.home))
        out = subprocess.run([SH, sh_path(self.script)], stdin=subprocess.DEVNULL, env=env,
                             capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)

    def helpers(self):
        with open(os.path.join(self.home, ".config", "xfce4", "helpers.rc")) as fh:
            return fh.read()

    def test_sets_browser_once_and_adds_new_launchers(self):
        self.run_first()
        self.run_first()
        self.assertEqual(self.helpers().count("WebBrowser=cloudbite-browser"), 1)
        self.assertTrue(os.path.exists(os.path.join(self.home, "Desktop", "signin-codex.desktop")))

    def bashrc(self):
        with open(os.path.join(self.home, ".bashrc")) as fh:
            return fh.read()

    def test_profile_line_is_moved_after_nvm_and_stays_last(self):
        nvm = 'export NVM_DIR=/usr/local/share/nvm\n. "$NVM_DIR/nvm.sh"\n'
        with open(os.path.join(self.home, ".bashrc"), "w", newline="\n") as fh:
            fh.write("# user\nalias ll='ls -l'\n\n" + PROFILE_LINE + "\n\n" + nvm)
        self.run_first()
        first = self.bashrc()
        self.run_first()
        self.assertEqual(self.bashrc(), first, "idempotent")
        self.assertEqual(first.count(PROFILE_LINE), 1)
        self.assertTrue(first.rstrip("\n").endswith(nvm + "\n" + PROFILE_LINE), first)
        self.assertTrue(first.startswith("# user\nalias ll='ls -l'\n"))

    def test_missing_bashrc_gets_the_line(self):
        self.run_first()
        self.assertEqual(self.bashrc().strip(), PROFILE_LINE)

    def test_user_choices_are_kept(self):
        os.makedirs(os.path.join(self.home, ".config", "xfce4"))
        with open(os.path.join(self.home, ".config", "xfce4", "helpers.rc"), "w") as fh:
            fh.write("WebBrowser=firefox\n")
        os.makedirs(os.path.join(self.home, "Desktop"))
        with open(os.path.join(self.home, "Desktop", "signin-codex.desktop"), "w") as fh:
            fh.write("mine\n")
        self.run_first()
        self.assertEqual(self.helpers(), "WebBrowser=firefox\n")
        with open(os.path.join(self.home, "Desktop", "signin-codex.desktop")) as fh:
            self.assertEqual(fh.read(), "mine\n")


if __name__ == "__main__":
    unittest.main(verbosity=2)
