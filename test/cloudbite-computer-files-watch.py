"""Files watcher tests: synthetic temp workspaces, the real files agent without a transport, and a fake agent
CLI that logs its argv.  No external network; nothing here is live persistence, VM or latency evidence."""
import importlib.util
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
WATCH = HERE / "images/cloudbite-computer/files-watch.py"
AGENT = HERE / "images/cloudbite-computer/files-agent.py"
spec = importlib.util.spec_from_file_location("files_watch", WATCH)
fw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fw)
SKIPS = []
OUTPUTS = []
SECRET = "SECRET-CONTENT-MARKER-7f3a"

FAKE_AGENT = r'''
import json, os, sys, time
args = sys.argv[1:]
state = args[args.index("--state") + 1]
cmd = [a for a in args if not a.startswith("--state") and a != state and not a.startswith("--capability")]
i = 0
while i < len(cmd) and cmd[i] != cmd[i].lstrip("-"):
    i += 1
command, rest = cmd[i], cmd[i + 1:]
with open(os.path.join(state, "calls.jsonl"), "a", encoding="utf-8") as log:
    log.write(json.dumps([command] + rest) + "\n")
try:
    with open(os.path.join(state, "behavior.json"), encoding="utf-8") as f:
        behavior = json.load(f).get(command, {})
except FileNotFoundError:
    behavior = {}
time.sleep(behavior.get("sleep", 0))
if behavior.get("exit"):
    sys.stdout.write("Traceback: database is locked\n")
    sys.exit(behavior["exit"])
if behavior.get("code"):
    print(json.dumps({"ok": False, "code": behavior["code"]}))
    sys.exit(2)
defaults = {"mark-dirty": {"state": "dirty", "dirtyRev": 1}, "reconcile": {"results": []}, "sync": {"results": []},
            "create-dir": {"created": True}, "resume": {"draining": False},
            "prepare-end": {"dirty": [], "uploading": [], "conflict": [], "unconfirmedOps": [], "open": [],
                            "ready": True, "remoteSaved": True, "safeToDelete": True, "errors": []}}
result = dict(defaults.get(command, {}), **behavior.get("result", {}))
print(json.dumps(dict(ok=True, **result)))
'''


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


class Env:
    def __init__(self, fake=True, home=None):
        self.base = Path(tempfile.mkdtemp(prefix="cbwatch-")).resolve()
        self.root = self.base / "CloudFiles"
        self.root.mkdir(mode=0o700)
        self.state = self.base / "watch"
        self.agent_state = self.base / "agent-state"
        self.home = home
        if fake:
            self.agent = self.base / "fake-agent.py"
            self.agent.write_text(FAKE_AGENT, encoding="utf-8")
            self.agent_state.mkdir(mode=0o700)
            db = sqlite3.connect(str(self.agent_state / "journal.sqlite3"))
            db.execute("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            db.execute("INSERT INTO meta VALUES('root', ?)", (json.dumps(str(self.root)),))
            db.commit()
            db.close()
        else:
            self.agent = AGENT
            out = self.agent_cli("init", "--root", str(self.root), "--workspace-id", "ws1", "--machine-id", "m1")
            check(out.get("configured"), out)

    def cleanup(self):
        shutil.rmtree(self.base, ignore_errors=True)

    def write(self, rel, data=b"x", mode=None):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def behave(self, **behavior):
        (self.agent_state / "behavior.json").write_text(json.dumps(behavior), encoding="utf-8")

    def calls(self, command=None):
        path = self.agent_state / "calls.jsonl"
        rows = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []
        return [r for r in rows if command is None or r[0] == command]

    def env(self):
        env = dict(os.environ, PYTHONIOENCODING="utf-8")
        if self.home:
            env.update(HOME=str(self.home), USERPROFILE=str(self.home))
        return env

    def argv(self, *args, state=None, root=None, extra=()):
        return [sys.executable, "-B", str(WATCH), "--state", str(state or self.state), "--agent", str(self.agent),
                "--agent-state", str(self.agent_state), "--root", str(root or self.root), *extra, *args]

    def watch(self, *args, rc=0, **kw):
        proc = subprocess.run(self.argv(*args, **kw), capture_output=True, env=self.env(), timeout=120)
        text = proc.stdout.decode("utf-8")
        OUTPUTS.append(text + proc.stderr.decode("utf-8", "replace"))
        check(proc.returncode == rc, "rc %s != %s: %s %s" % (proc.returncode, rc, text, proc.stderr[-2000:]))
        return json.loads(text.strip().splitlines()[-1])

    def agent_cli(self, *args):
        proc = subprocess.run([sys.executable, "-B", str(AGENT), "--state", str(self.agent_state), *args],
                              capture_output=True, timeout=60)
        OUTPUTS.append(proc.stdout.decode("utf-8"))
        return json.loads(proc.stdout.decode("utf-8").strip().splitlines()[-1])


def marked_paths(env):
    return sorted(c[1][len("--path="):] for c in env.calls("mark-dirty"))


def scan(env, *extra):
    return env.watch("scan-once", "--debounce", "0", *extra)


# ---- tests -----------------------------------------------------------------------------------------
def test_new_edit_real_agent():
    env = Env(fake=False)
    try:
        env.write("a.txt", b"one " + SECRET.encode())
        env.write("sub/b.txt", b"two")
        env.write("-rf.txt", b"dash")
        out = scan(env)
        check(out["marked"] == 3 and out["completedGeneration"], out)
        items = {i["path"]: i["state"] for i in env.agent_cli("list-local")["items"]}
        check(items == {"a.txt": "dirty", "sub/b.txt": "dirty", "-rf.txt": "dirty"}, items)
        env.write("a.txt", b"changed content")
        out = scan(env)
        check(out["marked"] == 1 and out["status"]["pendingMarks"] == 0, out)
    finally:
        env.cleanup()


def test_touch_and_atomic_replace():
    env = Env()
    try:
        path = env.write("doc.txt", b"aaaa")
        scan(env)
        check(marked_paths(env) == ["doc.txt"], env.calls())
        st = path.stat()
        os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 5 * 10 ** 9))  # touch: same bytes
        scan(env)
        scan(env)
        check(len(env.calls("mark-dirty")) == 1, "touch must not re-mark: %s" % env.calls())
        tmp = env.write(".doc.txt.tmp-1", b"bbbb")  # atomic save: same size, mtime preserved
        st = path.stat()
        os.utime(tmp, ns=(st.st_atime_ns, st.st_mtime_ns))
        os.replace(tmp, path)
        scan(env)
        check(len(env.calls("mark-dirty")) == 2, "atomic replace must re-mark: %s" % env.calls())
    finally:
        env.cleanup()


class Runner:
    def __init__(self, answers=None):
        self.calls = []
        self.answers = answers or {}

    def __call__(self, args, timeout=None):
        self.calls.append(list(args))
        answer = self.answers.get(args[0], {"ok": True, "results": []})
        return answer(args) if callable(answer) else dict(answer)


def in_process(answers=None):
    base = Path(tempfile.mkdtemp(prefix="cbwatch-lib-")).resolve()
    root = base / "CloudFiles"
    root.mkdir()
    state = base / "state"
    state.mkdir()
    clock = [1000.0]
    runner = Runner(answers)
    w = fw.Watcher(str(state), str(root), runner, clock=lambda: clock[0])
    return base, root, w, runner, clock


def test_debounce_and_growing_file():
    base, root, w, runner, clock = in_process()
    try:
        (root / "f.txt").write_bytes(b"1")
        w.scan_step(1000)
        check(w.mark_pending(2.0, 50) == 0, "inside debounce window")
        clock[0] += 1.0
        (root / "f.txt").write_bytes(b"12")
        w.scan_step(1000)  # changed again: window restarts
        clock[0] += 1.5
        check(w.mark_pending(2.0, 50) == 0, "restarted window")
        clock[0] += 1.0
        with open(root / "f.txt", "ab") as f:  # grows between scan and hash
            f.write(b"345")
        check(w.mark_pending(2.0, 50) == 0 and not runner.calls, "unstable file must not be marked")
        clock[0] += 2.5
        w.scan_step(1000)
        check(w.mark_pending(2.0, 50) == 1 and runner.calls == [["mark-dirty", "--path=f.txt"]], runner.calls)
    finally:
        w.close()
        shutil.rmtree(base, ignore_errors=True)


def test_offline_real_agent_preserves_and_pauses():
    env = Env(fake=False)
    try:
        env.write("a.txt", b"keep me")
        env.write("dir/b.txt", b"keep me too")
        out = scan(env, "--sync")
        check(out["sync"]["pause"] == "transport_not_configured", out)
        check((env.root / "a.txt").read_bytes() == b"keep me" and (env.root / "dir/b.txt").read_bytes() == b"keep me too",
              "originals untouched")
        env.write("c.txt", b"new while offline")
        out = scan(env, "--sync")
        check("sync" not in out and out["marked"] == 1 and out["status"]["pause"] == "transport_not_configured", out)
        end = env.watch("prepare-end", "--timeout", "20")
        check(not end["verified"] and not end["agentReady"] and end["dirty"] >= 1, end)
        check("paused_transport_not_configured" in end["blocking"] and end["unconfirmedOps"] == 1, end)
        out = env.watch("resume")
        check(out["agentResumed"] and env.watch("status")["pause"] is None, out)
    finally:
        env.cleanup()


def test_credential_pause_and_resume():
    env = Env()
    try:
        env.write("a.txt")
        env.behave(sync={"result": {"results": [{"requestId": "r1", "phase": "prepared", "code": "capability_expired"}]}})
        out = scan(env, "--sync")
        check(out["sync"]["pause"] == "credential_expired", out)
        env.write("b.txt")
        scan(env, "--sync")
        check(len(env.calls("sync")) == 1, "paused: no further sync %s" % env.calls())
        check(len(env.calls("mark-dirty")) == 2, "local marking continues while paused")
        env.behave(**{"prepare-end": {"result": {"dirty": ["b.txt"], "ready": False, "remoteSaved": False}}})
        end = env.watch("prepare-end", "--timeout", "20")
        check(env.calls("prepare-end") == [["prepare-end"]], "paused: report only, no flush %s" % env.calls())
        check(not end["verified"] and "paused_credential_expired" in end["blocking"], end)
        env.watch("resume")
        check(env.watch("status")["pause"] is None and env.calls("resume"), env.calls())
    finally:
        env.cleanup()


def test_backoff_then_retry_budget():
    base, root, w, runner, clock = in_process({"sync": {"ok": True, "results": [{"path": "x", "code": "backend_error"}]}})
    try:
        last = 0
        for n in range(1, fw.MAX_FAILURES + 1):
            check(w.sync_due(force=True), "due at attempt %d" % n)
            out = w.sync(5.0)
            until = w.get("backoffUntil")
            check(out["failures"] == n and until > clock[0] and until - clock[0] >= last, (n, out, until))
            last = until - clock[0]
            check(not w.sync_due(force=True) or n == fw.MAX_FAILURES, "inside backoff")
            clock[0] = until + 0.1
        check(w.get("pause") == "retry_exhausted" and not w.sync_due(force=True), w.status())
        check(len([c for c in runner.calls if c[0] == "sync"]) == fw.MAX_FAILURES, "bounded attempts")
    finally:
        w.close()
        shutil.rmtree(base, ignore_errors=True)


def test_large_file_blocks_end():
    env = Env()
    try:
        env.write("big.bin", b"z" * 2000)
        env.write("small.txt", b"ok")
        out = env.watch("scan-once", "--debounce", "0", extra=("--max-file-bytes", "1024"))
        check(out["status"]["scope"]["unsupported"]["reasons"] == {"too_large": 1}, out)
        end = env.watch("prepare-end", "--timeout", "20", extra=("--max-file-bytes", "1024"))
        check(end["agentReady"] and end["managedScanComplete"] and end["scanLimited"] and not end["verified"], end)
        check("unsupported_files" in end["blocking"], end)
        check(env.watch("status", rc=2, extra=("--max-file-bytes", "2048"))["code"] == "config_mismatch", "pinned")
    finally:
        env.cleanup()


def test_skip_scopes_and_names():
    env = Env()
    try:
        for rel in ("node_modules/x.js", ".git/HEAD", ".ssh/id", ".env", "keys/server.pem", "prof/Login Data",
                    "prof/notes.txt", ".config/app.ini", "docs/ok.txt", ".goutputstream-AB12", "a.swp", "straße.txt",
                    "build/__pycache__/m.pyc"):
            env.write(rel, b"data")
        out = scan(env)
        check(marked_paths(env) == ["docs/ok.txt"], env.calls())
        scope = out["status"]["scope"]
        check(scope["excluded"]["reasons"] == {"dependencies": 1, "vcs": 1, "transient": 2, "build_cache": 1}, scope)
        check(scope["protected"]["reasons"] == {"credential": 4, "profile": 1}, scope)
        check(scope["unsupported"]["reasons"] == {"name_ambiguous": 1}, scope)
        allowed = env.watch("scan-once", "--debounce", "0", state=env.base / "watch2", extra=("--allow", "node_modules"))
        check("node_modules/x.js" in marked_paths(env) and allowed["status"]["scope"]["excluded"]["count"] == 4, allowed)
        check(env.watch("status", rc=2, state=env.base / "watch3", extra=("--allow", ".ssh"))["code"]
              == "invalid_argument", "credentials can never be allowlisted")
        if os.name == "nt":
            SKIPS.append("posix-only names (backslash, control char, undecodable, case collision): Windows filesystem")
            return
        for rel in ("back\\slash.txt", "ctl\x01.txt", "Dup.txt", "dup.txt"):
            env.write(rel, b"n")
        os.close(os.open(os.path.join(os.fsencode(env.root), b"bad\xff.txt"), os.O_CREAT | os.O_WRONLY, 0o600))
        out = scan(env)
        reasons = out["status"]["scope"]["unsupported"]["reasons"]
        check(reasons == {"name_ambiguous": 1, "name_invalid": 2, "name_undecodable": 1, "path_collision": 1}, reasons)
        check(marked_paths(env).count("Dup.txt") == 1 and "dup.txt" not in marked_paths(env), env.calls())
    finally:
        env.cleanup()


def test_symlinks_not_followed():
    env = Env()
    try:
        outside = env.base / "outside"
        outside.mkdir()
        (outside / "secret.txt").write_text(SECRET)
        try:
            os.symlink(str(outside / "secret.txt"), str(env.root / "link.txt"))
            os.symlink(str(outside), str(env.root / "linkdir"), target_is_directory=True)
        except (OSError, NotImplementedError):
            SKIPS.append("symlinks: not permitted on this host")
            return
        env.write("real.txt")
        out = scan(env)
        check(marked_paths(env) == ["real.txt"], env.calls())
        check(out["status"]["scope"]["protected"]["reasons"] == {"symlink": 2}, out)
    finally:
        env.cleanup()


def test_drain_limits_and_timeout():
    env = Env()
    try:
        for i in range(30):
            env.write("d%d/f%d.txt" % (i % 3, i))
        end = env.watch("prepare-end", "--timeout", "20", "--end-max-entries", "10")
        check(not end["managedScanComplete"] and end["scanLimited"] and not end["verified"], end)
        check("scan_limit" in end["blocking"], end)
        env.watch("resume")
        env.behave(**{"prepare-end": {"sleep": 6}})
        started = time.monotonic()
        end = env.watch("prepare-end", "--timeout", "3")
        check(end["elapsedMs"] <= 3000 and not end["agentReady"] and not end["verified"], end)
        check(time.monotonic() - started < 3 + 1.5, "whole command bounded by --timeout (+ interpreter start)")
        check("agent_agent_timeout" in end["blocking"] and end["dirty"] is None and end["open"] is None, end)
        check(env.watch("scan-once", rc=2)["code"] == "draining", "draining refuses scans until resume")
    finally:
        env.cleanup()


def test_deletions_dedupe_and_block():
    env = Env()
    try:
        env.write("a.txt", b"a")
        env.write("b.txt", b"b")
        scan(env)
        os.unlink(env.root / "a.txt")
        for _ in range(3):
            out = scan(env)
        check(out["status"]["pendingDeletions"] == 1 and out["status"]["deletionSamples"] == ["a.txt"], out)
        os.replace(env.root / "b.txt", env.root / "c.txt")
        out = scan(env)
        check(out["status"]["deletionSamples"] == ["a.txt", "b.txt"] and "c.txt" in marked_paths(env), out)
        env.write("a.txt", b"back")
        out = scan(env)
        check(out["status"]["deletionSamples"] == ["b.txt"], out)
        env.write("tmp.txt", b"never marked")
        env.watch("scan-once", "--debounce", "60")
        os.unlink(env.root / "tmp.txt")
        out = scan(env)
        check(out["status"]["pendingDeletions"] == 1, "unmarked file deletion is not pending: %s" % out)
        check((env.root / "c.txt").exists(), "nothing deleted by the watcher")
        end = env.watch("prepare-end", "--timeout", "20")
        check(end["pendingDeletions"] == 1 and not end["verified"] and "deletions_unsupported" in end["blocking"], end)
        check(end["deleteSupport"] == "unsupported", end)
    finally:
        env.cleanup()


def test_lock_drain_handoff():
    env = Env()
    try:
        env.write("a.txt")
        proc = subprocess.Popen(env.argv("run", "--interval", "2", "--max-runtime", "120", "--debounce", "0"),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env.env())
        try:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and not env.calls("mark-dirty"):
                time.sleep(0.2)
            check(env.calls("mark-dirty"), "run marked the file")
            check(env.watch("scan-once", rc=2)["code"] == "watcher_busy", "one watcher")
            check(env.watch("resume")["deferred"], "resume defers to the running watcher")
            end = env.watch("prepare-end", "--timeout", "20")
            out, _ = proc.communicate(timeout=30)
            OUTPUTS.append(out.decode("utf-8"))
            check(json.loads(out.decode("utf-8"))["stopped"] == "drain_requested", out)
            check(end["verified"] and end["draining"], end)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.communicate()
        check(env.watch("run", "--interval", "2", rc=2)["code"] == "draining", "no restart while draining")
        env.watch("resume")
        check(scan(env)["completedGeneration"], "resumed")
    finally:
        env.cleanup()


def test_restart_progress():
    env = Env()
    try:
        for i in range(25):
            env.write("p%d/q/f%d.txt" % (i % 5, i))
        first = env.watch("scan-once", "--max-entries", "5", "--debounce", "0")
        check(not first["completedGeneration"] and first["status"]["generation"] == 1, first)
        proc = subprocess.Popen(env.argv("run", "--interval", "2", "--max-entries", "1", "--debounce", "60"),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env.env())
        time.sleep(3)
        proc.kill()  # crash: the lock is released with the process
        proc.communicate()
        rounds = 0
        while True:
            out = env.watch("scan-once", "--max-entries", "5", "--debounce", "0")
            rounds += 1
            check(out["status"]["generation"] == 1 and rounds < 40, out)
            if out["completedGeneration"]:
                break
        check(out["status"]["tracked"] == 25, out)
        while out["status"]["pendingMarks"]:
            out = scan(env)
        check(len(marked_paths(env)) == 25, marked_paths(env))
    finally:
        env.cleanup()


def test_end_ready_and_not_ready():
    env = Env()
    try:
        env.write("a.txt")
        end = env.watch("prepare-end", "--timeout", "20")
        check(end["verified"] and end["managedScanComplete"] and not end["scanLimited"] and end["dirty"] == 0, end)
        check(marked_paths(env) == ["a.txt"] and env.calls("prepare-end") == [["prepare-end", "--flush"]], env.calls())
        env.watch("resume")
        env.behave(**{"prepare-end": {"result": {"dirty": ["a.txt"], "ready": False, "remoteSaved": False,
                                                 "errors": ["backend_error"]}}})
        end = env.watch("prepare-end", "--timeout", "20")
        check(not end["verified"] and end["dirty"] == 1 and end["errors"] == 1 and "agent_not_ready" in end["blocking"],
              end)
        env.watch("resume")
        env.behave(**{"prepare-end": {"result": {"open": "1", "ready": True}}})
        end = env.watch("prepare-end", "--timeout", "20")
        check(not end["verified"] and not end["agentReady"] and "agent_report_malformed" in end["blocking"], end)
        check(all(end[k] is None for k in ("dirty", "uploading", "conflict", "unconfirmedOps", "open")), end)
        env.watch("resume")
        env.behave(**{"prepare-end": {"result": {"open": ["a.txt"]}}})
        end = env.watch("prepare-end", "--timeout", "20")
        check(not end["verified"] and not end["agentReady"] and end["open"] == 1, "ready with open lists is not ready")
    finally:
        env.cleanup()


def test_create_dir_for_unregistered_parent():
    env = Env()
    try:
        env.write("d1/d2/f.txt")
        env.behave(sync={"result": {"results": [{"path": "d1/d2/f.txt", "code": "parent_not_registered"}]}})
        out = scan(env, "--sync")
        check(env.calls("create-dir") == [["create-dir", "--path=d1"], ["create-dir", "--path=d1/d2"]], env.calls())
        check(out["sync"]["createdDirs"] == 2 and out["sync"]["pause"] is None, out)
    finally:
        env.cleanup()


def test_agent_crash_and_busy_retry():
    env = Env()
    try:
        env.write("a.txt")
        env.behave(**{"mark-dirty": {"exit": 1}})
        out = scan(env)
        check(out["status"]["pendingMarks"] == 1 and out["status"]["markErrors"] == 1, out)
        env.behave(**{"mark-dirty": {"code": "busy"}})
        out = scan(env)
        check(out["status"]["pendingMarks"] == 1, out)
        env.behave()
        out = scan(env)
        check(out["status"]["pendingMarks"] == 0 and len(env.calls("mark-dirty")) == 3, out)
        env.behave(**{"mark-dirty": {"code": "path_collision"}})
        env.write("b.txt")
        out = scan(env)
        check(out["status"]["scope"]["unsupported"]["reasons"] == {"agent_path_collision": 1}, out)
    finally:
        env.cleanup()


def test_config_and_root_verification():
    env = Env()
    try:
        other = env.base / "other"
        other.mkdir()
        check(env.watch("status", rc=2, root=other)["code"] == "root_mismatch", "root must equal the agent root")
        check(env.watch("status", rc=2, state=env.root / ".w")["code"] == "root_forbidden", "state outside root")
        home_env = Env()
        home_env.home = home_env.root  # HOME itself (or anything containing it) is never the workspace
        try:
            check(home_env.watch("status", rc=2)["code"] == "root_forbidden", "root may not be HOME")
        finally:
            home_env.cleanup()
        env.watch("status")
        check(env.watch("status", rc=2, extra=("--capability", str(env.base / "cap.json")))["code"]
              == "config_mismatch", "config pinned at first use")
        if os.name != "nt":
            check(oct(os.stat(env.state).st_mode & 0o777) == "0o700", "private state dir")
            check(oct(os.stat(env.state / "config.json").st_mode & 0o777) == "0o600", "private config")
    finally:
        env.cleanup()


def test_argument_bounds():
    env = Env()
    try:
        for args in (("run", "--interval", "1"), ("run", "--max-runtime", "30000"), ("prepare-end", "--timeout", "31"),
                     ("scan-once", "--max-entries", "1001"), ("scan-once", "--debounce", "61")):
            check(env.watch(*args, rc=2)["code"] == "invalid_argument", args)
        check(env.watch("status", rc=2, extra=("--max-file-bytes", str(33 << 20)))["code"] == "invalid_argument", "cap")
    finally:
        env.cleanup()


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for test in tests:
        test()
        passed += 1
        print("ok", test.__name__)
    check(not any(SECRET in text for text in OUTPUTS), "file contents leaked into output")
    print("files-watch: %d passed, %d skipped (%s) on %s" % (passed, len(SKIPS), "; ".join(SKIPS) or "-", sys.platform))


if __name__ == "__main__":
    main()
