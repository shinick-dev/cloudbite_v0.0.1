"""Unit checks for images/cloudbite-computer/install.py: archive extraction, npm links,
download integrity and the fail-closed tool verification.  No network, root or image build.
    python3 -I test/cloudbite-computer-install.py
"""
import hashlib
import importlib.util
import io
import os
import sys
import tarfile
import tempfile
import unittest
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "cloudbite_install", os.path.join(HERE, "..", "images", "cloudbite-computer", "install.py"))
install = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install)
install.emit = lambda obj: None


def can_symlink():
    with tempfile.TemporaryDirectory() as d:
        try:
            os.symlink("x", os.path.join(d, "l"))
            return True
        except (OSError, NotImplementedError):
            return False


def make_tar(path, entries):
    """entries: (name, kind, payload) with kind file|dir|sym|lnk|fifo."""
    with tarfile.open(path, "w:gz") as tar:
        for name, kind, payload in entries:
            info = tarfile.TarInfo(name)
            data = None
            if kind == "file":
                data = payload.encode()
                info.size, info.mode = len(data), 0o755
            elif kind == "dir":
                info.type, info.mode = tarfile.DIRTYPE, 0o755
            elif kind == "sym":
                info.type, info.linkname = tarfile.SYMTYPE, payload
            elif kind == "lnk":
                info.type, info.linkname = tarfile.LNKTYPE, payload
            elif kind == "fifo":
                info.type = tarfile.FIFOTYPE
            tar.addfile(info, io.BytesIO(data) if data is not None else None)


NODE_LAYOUT = [
    ("node-v22/", "dir", None),
    ("node-v22/bin/", "dir", None),
    ("node-v22/bin/node", "file", "#!/bin/sh\necho v22.20.0\n"),
    ("node-v22/bin/npm", "sym", "../lib/node_modules/npm/bin/npm-cli.js"),
    ("node-v22/bin/npx", "sym", "../lib/node_modules/npm/bin/npx-cli.js"),
    ("node-v22/lib/node_modules/npm/bin/npm-cli.js", "file", "// npm\n"),
    ("node-v22/lib/node_modules/npm/bin/npx-cli.js", "file", "// npx\n"),
]


@unittest.skipUnless(can_symlink(), "symlinks unavailable on this host")
class Extract(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = os.path.realpath(self.tmp.name)
        self.dest = os.path.join(self.base, "dest")
        self.archive = os.path.join(self.base, "a.tar.gz")

    def tearDown(self):
        self.tmp.cleanup()

    def outside(self):
        return sorted(e for e in os.listdir(self.base) if e not in ("dest", "a.tar.gz"))

    def test_node_relative_npm_links_kept(self):
        make_tar(self.archive, NODE_LAYOUT)
        self.assertEqual(install.extract(self.archive, self.dest, 1), 0)
        npm = os.path.join(self.dest, "bin", "npm")
        self.assertTrue(os.path.islink(npm))
        self.assertEqual(os.readlink(npm), "../lib/node_modules/npm/bin/npm-cli.js")
        with open(npm) as fh:
            self.assertEqual(fh.read(), "// npm\n")
        self.assertTrue(install.ensure_node_cli_links(self.dest))

    def test_npm_links_recreated_when_missing_or_wrong(self):
        make_tar(self.archive, [e for e in NODE_LAYOUT if e[1] != "sym"]
                 + [("node-v22/bin/npx", "file", "not a link\n")])
        install.extract(self.archive, self.dest, 1)
        self.assertFalse(os.path.lexists(os.path.join(self.dest, "bin", "npm")))
        self.assertTrue(install.ensure_node_cli_links(self.dest))
        for exe in ("npm", "npx"):
            link = os.path.join(self.dest, "bin", exe)
            self.assertTrue(os.path.islink(link) and os.path.isfile(link), exe)

    def test_npm_missing_scripts_reported(self):
        make_tar(self.archive, NODE_LAYOUT[:3])
        install.extract(self.archive, self.dest, 1)
        self.assertFalse(install.ensure_node_cli_links(self.dest))

    def test_escapes_and_pivots_rejected(self):
        make_tar(self.archive, [
            ("t/ok.txt", "file", "ok"),
            ("t/abs", "sym", "/etc/passwd"),
            ("t/up", "sym", "../../outside-link"),
            ("t/../escape.txt", "file", "x"),
            ("/abs.txt", "file", "x"),
            ("t/fifo", "fifo", None),
            ("t/pivot", "sym", ".."),
            ("t/pivot/written.txt", "file", "x"),
            ("t/early", "sym", "sub/back/.."),
            ("t/sub/back", "sym", ".."),
            ("t/early/through.txt", "file", "x"),
            ("t/hard-out", "lnk", "t/../../../etc/passwd"),
            ("t/hard-in", "lnk", "t/ok.txt"),
        ])
        skipped = install.extract(self.archive, self.dest, 1)
        self.assertEqual(self.outside(), [])
        listing = sorted(os.listdir(self.dest))
        for bad in ("abs", "up", "escape.txt", "fifo", "hard-out"):
            self.assertNotIn(bad, listing)
        # pivot/early may survive only as plain in-tree directories or in-tree links.
        self.assertFalse(os.path.islink(os.path.join(self.dest, "pivot")))
        self.assertFalse(os.path.lexists(os.path.join(self.base, "written.txt")))
        self.assertFalse(os.path.lexists(os.path.join(self.base, "through.txt")))
        with open(os.path.join(self.dest, "hard-in")) as fh:
            self.assertEqual(fh.read(), "ok")
        self.assertGreaterEqual(skipped, 7)
        root = os.path.realpath(self.dest)
        for base, dirs, files in os.walk(self.dest):
            for e in dirs + files:
                self.assertTrue(install._inside(os.path.realpath(os.path.join(base, e)), root), e)


    def test_escapes_rejected_without_data_filter(self):
        # Pythons without the tarfile filter (e.g. an unpatched 3.11) rely on our checks alone.
        saved = install.TAR_FILTER
        install.TAR_FILTER = {"filter": "fully_trusted"} if hasattr(tarfile, "fully_trusted_filter") else {}
        try:
            self.test_escapes_and_pivots_rejected()
        finally:
            install.TAR_FILTER = saved


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


class Fetch(unittest.TestCase):
    URL = "https://downloads.example.test/a.tar.gz"
    BODY = b"payload" * 1000

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dest = os.path.join(self.tmp.name, "a")
        self.calls = []

    def tearDown(self):
        self.tmp.cleanup()

    def opener(self, *outcomes):
        seq = list(outcomes)

        def open_(req, timeout):
            self.calls.append(req.get_header("User-agent"))
            item = seq.pop(0) if len(seq) > 1 else seq[0]
            if isinstance(item, Exception):
                raise item
            return FakeResponse(item)
        return open_

    def test_match_sends_fixed_user_agent(self):
        digest = hashlib.sha256(self.BODY).hexdigest()
        self.assertIsNone(install.fetch(self.URL, self.dest, "sha256", digest, opener=self.opener(self.BODY)))
        self.assertEqual(self.calls, [install.USER_AGENT])
        self.assertFalse(install.USER_AGENT.startswith("Python-urllib"))

    def test_mismatch_is_not_retried_or_accepted(self):
        self.assertEqual(install.fetch(self.URL, self.dest, "sha256", "0" * 64, opener=self.opener(self.BODY)),
                         "digest_mismatch")
        self.assertEqual(len(self.calls), 1)

    def test_network_glitch_retried_then_verified(self):
        digest = hashlib.sha512(self.BODY).hexdigest()
        reason = install.fetch(self.URL, self.dest, "sha512", digest,
                               opener=self.opener(OSError("reset"), OSError("reset"), self.BODY))
        self.assertIsNone(reason)
        self.assertEqual(len(self.calls), 3)

    def test_http_error_bounded(self):
        err = urllib.error.HTTPError(self.URL, 403, "Forbidden", {}, None)
        self.assertEqual(install.fetch(self.URL, self.dest, "sha256", "0" * 64, opener=self.opener(err)), "http_403")
        self.assertEqual(len(self.calls), install.FETCH_ATTEMPTS)

    def test_plain_http_refused(self):
        self.assertEqual(install.fetch("http://x/a", self.dest, "sha256", "0" * 64, opener=self.opener(self.BODY)),
                         "not_https")
        self.assertEqual(self.calls, [])

    def test_cursor_failure_codes(self):
        real = install.fetch
        try:
            for reason, code in (("digest_mismatch", "computer_cursor_digest_mismatch"),
                                 ("http_403", "computer_cursor_download_failed")):
                install.fetch = lambda *a, r=reason, **k: r
                self.assertEqual(install.install_cursor(self.tmp.name), {"code": code})
        finally:
            install.fetch = real

    def test_recorded_cursor_artifact(self):
        self.assertEqual(install.CURSOR["sha256"],
                         "3aa3f48cd7a3909a98c9b3f2a4085f0c021088bf826690b22c61f424c843e552")
        self.assertTrue(install.CURSOR["url"].startswith("https://downloads.cursor.com/lab/2026.10.16-e3cb207/"))


class Verify(unittest.TestCase):
    def records(self):
        return {t: {"version": "1"} for t in install.REQUIRED_TOOLS}

    def test_all_probed(self):
        tools = self.records()
        self.assertEqual(install.verify_tools(tools, "/h", probe=lambda argv, home: "1.0.0"), [])
        self.assertTrue(all(r["installed"] and r["probe_version"] == "1.0.0" for r in tools.values()))

    def test_failed_probe_is_not_installed_and_fails_closed(self):
        tools = self.records()
        tools["codex"] = {"code": "computer_codex_install_failed"}
        probed = []

        def probe(argv, home):
            probed.append(argv[0])
            return None if argv[0].endswith("/claude") else "1.0.0"
        missing = install.verify_tools(tools, "/h", probe=probe)
        self.assertEqual(missing, ["claude-code", "codex"])
        self.assertFalse(tools["claude-code"]["installed"])
        self.assertEqual(tools["claude-code"]["code"], "computer_claude-code_verify_failed")
        self.assertFalse(tools["codex"]["installed"])
        self.assertEqual(tools["codex"]["code"], "computer_codex_install_failed")
        self.assertNotIn("/usr/local/bin/codex", probed)

    def test_absent_required_tool_missing(self):
        self.assertEqual(install.verify_tools({}, "/h", probe=lambda a, h: "1"), list(install.REQUIRED_TOOLS))

    def test_required_set(self):
        self.assertEqual(set(install.REQUIRED_TOOLS), set(install.COMMANDS))


if __name__ == "__main__":
    unittest.main(verbosity=1)
