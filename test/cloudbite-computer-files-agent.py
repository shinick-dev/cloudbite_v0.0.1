"""Files agent fault tests: synthetic temp directories, a fake transport and a loopback-only fake HTTP
server shaped like the core routes.  No external network; nothing here is live persistence evidence."""
import contextlib
import hashlib
import http.server
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import types
import unicodedata
import urllib.parse
from pathlib import Path

AGENT_PATH = Path(__file__).resolve().parent.parent / "images/cloudbite-computer/files-agent.py"
spec = importlib.util.spec_from_file_location("files_agent", AGENT_PATH)
fa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fa)
SKIPS = []


def sha(data):
    return hashlib.sha256(data).hexdigest()


class Fake:
    """File-backed fake server so a crashed child process and the parent see the same remote state."""
    configured = True
    eviction_policy = "verified"  # MOCK: this fake declares verified persistence so eviction logic can be tested

    def __init__(self, store):
        self.store = Path(store)
        self.store.mkdir(exist_ok=True)
        self.fetches = 0
        self.corrupt = self.extra = False
        self.reject = None
        self.on_commit = None
        self.lose_response = False
        self.crash_in_fetch = self.crash_in_commit = False

    def _load(self):
        path = self.store / "state.json"
        return json.loads(path.read_text()) if path.exists() else {"current": {}, "objects": {}, "ops": {}, "begins": {}}

    def _save(self, state):
        (self.store / "state.json").write_text(json.dumps(state))

    def put(self, file_id, version, data, path, mode=0o644):
        state = self._load()
        state["objects"][file_id + "@" + version] = data.hex()
        state["current"][file_id] = version
        self._save(state)
        return {"fileId": file_id, "path": path, "versionId": version, "size": len(data), "sha256": sha(data),
                "mode": mode}

    def body(self, file_id, version=None):
        state = self._load()
        return bytes.fromhex(state["objects"][file_id + "@" + (version or state["current"][file_id])])

    def fetch_version(self, req):
        self.fetches += 1
        data = self.body(req["fileId"], req["versionId"])
        if self.corrupt:
            data = data[:-1] + bytes([data[-1] ^ 1])
        if self.extra:
            data += b"x" * 10
        for i in range(0, len(data), 4):
            if self.crash_in_fetch and i:
                os._exit(9)
            yield data[i:i + 4]

    def begin_upload(self, req):
        if self.reject:
            raise fa.BackendError(self.reject)
        state = self._load()
        state["begins"][req["requestId"]] = state["begins"].get(req["requestId"], 0) + 1
        state["ops"].setdefault(req["requestId"], {"req": req, "body": "", "receipt": None})
        self._save(state)
        return {"requestId": req["requestId"], "uploadId": "u_" + req["requestId"]}

    def put_body(self, req, handle):
        state = self._load()
        op = state["ops"][req["uploadId"][2:]]
        op["body"] = handle.read().hex()
        self._save(state)

    def commit_upload(self, req):
        state = self._load()
        op = state["ops"][req["requestId"]]
        body, upload = bytes.fromhex(op["body"]), op["req"]
        file_id = upload["fileId"] or "f_" + upload["requestId"][:8]
        if state["current"].get(file_id) != upload["baseVersion"]:
            raise fa.BackendError("base_version_conflict")
        assert sha(body) == upload["sha256"] and len(body) == upload["size"]
        version = "v_%d" % (len(state["objects"]) + 1)
        state["objects"][file_id + "@" + version] = body.hex()
        state["current"][file_id] = version
        op["receipt"] = {"requestId": upload["requestId"], "fileId": file_id, "versionId": version,
                         "baseVersion": upload["baseVersion"], "size": len(body), "sha256": sha(body),
                         "writerEpoch": upload["writerEpoch"], "canonical": True}
        self._save(state)
        if self.crash_in_commit:
            os._exit(9)
        if self.on_commit:
            self.on_commit()
        if self.lose_response:
            raise ConnectionError("response lost")
        return op["receipt"]

    def get_operation(self, req):
        op = self._load()["ops"].get(req["requestId"])
        if not op:
            return {"requestId": req["requestId"], "phase": "unknown_request"}
        if not op["receipt"]:
            return {"requestId": req["requestId"], "phase": "pending"}
        return {"requestId": req["requestId"], "phase": "committed", "receipt": op["receipt"]}

    def begins(self, request_id):
        return self._load()["begins"].get(request_id, 0)


class Env:
    def __init__(self, base, **cfg):
        self.base = Path(base)
        self.root = self.base / "workspace"
        self.state = self.base / "state"
        self.root.mkdir(exist_ok=True)
        self.fake = Fake(self.base / "remote")
        self.free = 10 << 30
        cfg.setdefault("reserve_bytes", 1000)
        fa.FilesAgent.init(str(self.state), str(self.root), "w_test", "m_test", **cfg).close()
        self.agent = self.reopen()

    def reopen(self, backend=None):
        if getattr(self, "agent", None):
            self.agent.close()
        self.agent = fa.FilesAgent(str(self.state), backend=backend or self.fake, disk_free=lambda _: self.free)
        return self.agent

    def staging(self):
        return sorted(os.listdir(self.state / "staging"))

    def touch(self, path):
        self.agent.close_lease(self.agent.open(path=path)["leaseId"])

    def entry(self, path):
        for item in self.agent.list_local(0, 500)["items"]:
            if item["path"] == path:
                return item
        raise AssertionError(path)


def expect(code, fn, *args, **kwargs):
    try:
        fn(*args, **kwargs)
    except fa.AgentError as err:
        assert err.code == code, (err.code, code)
        return
    raise AssertionError("expected " + code)


@contextlib.contextmanager
def env(**cfg):
    base = tempfile.mkdtemp(prefix="cb-files-agent-")
    e = Env(base, **cfg)
    try:
        yield e
    finally:
        if e.agent:
            e.agent.close()
        shutil.rmtree(base, ignore_errors=True)


def test_paths_and_root_boundaries():
    for bad in ("../x", "/abs", "a//b", "a\\b", "a/./b", "C:x", "a\x01b", "", "a/" + "n" * 256):
        expect("path_invalid", fa.check_rel, bad)
    for bad in (".ssh/id_ed25519", "proj/.aws/credentials", ".config/app.json", ".CACHE/x", "p/.git-credentials"):
        expect("path_forbidden", fa.check_rel, bad)
    assert fa.check_rel("proj/.config/ok.json")  # only top-level profile dirs are refused
    with env() as e:
        expect("path_forbidden", fa.FilesAgent.init, str(e.base / "s2"), str(e.base), "w", "m")  # state inside root
        expect("path_forbidden", fa.FilesAgent.init, str(e.base / "s3"), os.path.expanduser("~/.."), "w", "m")
        expect("path_invalid", e.agent.register, [e.fake.put("f_1", "v_1", b"x", "../escape")])
        (e.root / "real").mkdir()
        try:
            os.symlink(e.root / "real", e.root / "link", target_is_directory=True)
        except (OSError, NotImplementedError):
            SKIPS.append("symlink crossing (symlinks unavailable on this host)")
        else:
            expect("path_symlink", e.agent.register, [e.fake.put("f_1", "v_1", b"x", "link/a.txt")])
            expect("path_symlink", e.agent.mark_dirty, "link/a.txt")
        assert not (e.base / "escape").exists()


def test_unicode_names_and_metadata_only():
    nfd = unicodedata.normalize("NFD", "보고서/Café.txt")
    with env() as e:
        e.agent.register([e.fake.put("f_1", "v_1", b"hello", nfd), e.fake.put("f_2", "v_1", b"b" * 50, "big.bin")])
        expect("path_collision", e.agent.register, [e.fake.put("f_3", "v_1", b"z", unicodedata.normalize("NFC", nfd).upper())])
        listing, status = e.agent.list_local(0, 1), e.agent.status()
        assert listing["nextCursor"] and len(listing["items"]) == 1
        assert status["states"] == {"remote-only": 2}
        assert e.fake.fetches == 0 and os.listdir(e.root) == [], "metadata queries never hydrate bodies"
        e.agent.open(path=nfd)
        on_disk = os.listdir(e.root / nfd.split("/")[0])
        assert on_disk == [nfd.split("/")[1]], "name bytes preserved exactly"
        assert (e.root / nfd).read_bytes() == b"hello"


def test_open_verifies_before_activation():
    with env(max_transfer_bytes=100) as e:
        e.agent.register([e.fake.put("f_1", "v_1", b"version-one", "doc.txt", 0o640)])
        e.fake.corrupt = True
        expect("checksum_mismatch", e.agent.open, path="doc.txt")
        assert not (e.root / "doc.txt").exists() and e.staging() == []
        e.fake.corrupt, e.fake.extra = False, True
        expect("size_mismatch", e.agent.open, path="doc.txt")
        e.fake.extra = False
        first = e.agent.open(path="doc.txt")
        assert first["fetchedBytes"] == 11 and first["state"] == "clean"
        if os.name != "nt":
            assert stat.S_IMODE(os.stat(e.root / "doc.txt").st_mode) == 0o640
        else:
            SKIPS.append("POSIX mode preservation (Windows host)")
        fetches = e.fake.fetches
        assert e.agent.open(path="doc.txt")["fetchedBytes"] == 0 and e.fake.fetches == fetches, "cache hit"
        # A newer version whose download is corrupt leaves the verified older copy in place.
        e.agent.register([e.fake.put("f_1", "v_2", b"version-two!", "doc.txt")])
        e.fake.corrupt = True
        expect("checksum_mismatch", e.agent.open, path="doc.txt")
        assert (e.root / "doc.txt").read_bytes() == b"version-one"
        e.fake.corrupt = False
        assert e.agent.open(path="doc.txt", version="v_2")["versionId"] == "v_2"
        e.agent.register([e.fake.put("f_9", "v_1", b"y" * 101, "huge.bin")])
        expect("transfer_too_large", e.agent.open, path="huge.bin")


def test_unrecorded_local_edit_is_never_clobbered():
    with env() as e:
        e.agent.register([e.fake.put("f_1", "v_1", b"remote", "a.txt")])
        lease = e.agent.open(path="a.txt")["leaseId"]
        (e.root / "a.txt").write_bytes(b"edited by an app without telling the agent")
        e.agent.register([e.fake.put("f_1", "v_2", b"remote two", "a.txt")])
        expect("local_modified", e.agent.open, path="a.txt", version="v_2")
        assert (e.root / "a.txt").read_bytes().startswith(b"edited")
        assert e.entry("a.txt")["state"] == "dirty" and e.entry("a.txt")["baseVersion"] == "v_1"
        # A pre-existing workspace file at a catalog path is adopted, not replaced.
        (e.root / "mine.txt").write_bytes(b"my original")
        e.agent.register([e.fake.put("f_2", "v_1", b"server copy", "mine.txt")])
        expect("local_modified", e.agent.open, path="mine.txt")
        assert (e.root / "mine.txt").read_bytes() == b"my original"
        assert e.entry("mine.txt")["origin"] == "user"
        e.agent.close_lease(lease)


def test_upload_verified_receipt_and_change_during_upload():
    with env() as e:
        e.agent.register([e.fake.put("f_1", "v_1", b"one", "a.txt")])
        e.touch("a.txt")
        (e.root / "a.txt").write_bytes(b"two")
        e.agent.mark_dirty("a.txt")
        e.fake.on_commit = lambda: (e.root / "a.txt").write_bytes(b"three, typed during upload")
        result = e.agent.sync()["results"][0]
        assert result["phase"] == "committed" and result["state"] == "dirty"
        assert e.fake.body("f_1") == b"two"
        entry = e.entry("a.txt")
        assert entry["state"] == "dirty" and entry["baseVersion"] == result["versionId"], "new revision on top"
        e.fake.on_commit = None
        second = e.agent.sync()["results"][0]
        assert second["state"] == "clean" and e.fake.body("f_1") == b"three, typed during upload"
        assert e.agent.prepare_end()["ready"] is True
        # A brand-new local file goes up with no fileId and receives one from the receipt.
        (e.root / "new.txt").write_bytes(b"new")
        e.agent.mark_dirty("new.txt")
        assert e.agent.sync()["results"][0]["state"] == "clean"
        assert e.entry("new.txt")["fileId"] and e.entry("new.txt")["origin"] == "user"


def test_stale_and_mismatched_acks():
    with env() as e:
        e.agent.register([e.fake.put("f_1", "v_1", b"one", "a.txt")])
        e.touch("a.txt")
        (e.root / "a.txt").write_bytes(b"two")
        e.agent.mark_dirty("a.txt")
        old = e.agent.sync()["results"][0]
        old_receipt = e.fake._load()["ops"][old["requestId"]]["receipt"]
        (e.root / "a.txt").write_bytes(b"three!")
        e.agent.mark_dirty("a.txt")
        e.fake.lose_response = True
        pending = e.agent.sync()["results"][0]
        assert pending["phase"] == "unknown"
        late = e.agent.apply_ack(old_receipt)
        assert late["applied"] is False and late["code"] == "stale_ack"
        assert e.entry("a.txt")["state"] == "uploading"
        forged = dict(e.fake._load()["ops"][pending["requestId"]]["receipt"], sha256="0" * 64)
        assert e.agent.apply_ack(forged)["code"] == "receipt_mismatch"
        assert e.entry("a.txt")["state"] == "uploading"
        assert e.agent.prepare_end()["ready"] is False
        e.fake.lose_response = False
        assert e.agent.reconcile()["results"][0]["state"] == "clean"
        assert e.fake.begins(pending["requestId"]) == 1
        assert e.agent.prepare_end()["ready"] is True


def test_rejections_keep_dirty_data():
    with env() as e:
        e.agent.register([e.fake.put("f_1", "v_1", b"one", "a.txt")])
        e.agent.open(path="a.txt")
        (e.root / "a.txt").write_bytes(b"local edit")
        e.agent.mark_dirty("a.txt")
        e.fake.reject = "quota_exceeded"
        first = e.agent.sync()["results"][0]
        assert first["phase"] == "prepared" and e.entry("a.txt")["state"] == "uploading"
        e.fake.reject = None
        retried = e.agent.sync()["results"][0]
        assert retried["requestId"] == first["requestId"] and retried["state"] == "clean", "same request id on retry"
        # Someone else advanced the canonical version: keep the local copy, flag a conflict.
        e.fake.put("f_1", "v_other", b"other writer", "a.txt")
        (e.root / "a.txt").write_bytes(b"mine again")
        e.agent.mark_dirty("a.txt")
        assert e.agent.sync()["results"][0]["phase"] == "conflict"
        assert (e.root / "a.txt").read_bytes() == b"mine again" and e.entry("a.txt")["state"] == "conflict"
        report = e.agent.prepare_end()
        assert report["conflict"] == ["a.txt"] and not report["safeToDelete"] and not report["remoteSaved"]
        assert e.agent.evict()["evicted"] == []


def test_unconfigured_transport_never_claims_saved():
    with env() as e:
        (e.root / "a.txt").write_bytes(b"local only")
        e.agent.mark_dirty("a.txt")
        e.reopen(fa.UnconfiguredHttpBackend())
        report = e.agent.prepare_end(flush=True)
        assert report["ready"] is False and report["remoteSaved"] is False
        assert "transport_not_configured" in report["errors"] and report["uploading"] == ["a.txt"]
        assert e.agent.status()["transportConfigured"] is False
        assert (e.root / "a.txt").read_bytes() == b"local only"


def test_eviction_protects_dirty_pinned_open_and_user_files():
    with env() as e:
        names = ["clean.bin", "pinned.bin", "open.bin", "dirty.bin", "edited.bin"]
        e.agent.register([e.fake.put("f_%d" % i, "v_1", b"%d" % i * 100, n) for i, n in enumerate(names)])
        for n in names:
            e.agent.open(path=n)
        for lease in [r[0] for r in e.agent.db.execute(
                "SELECT l.lease_id FROM leases l JOIN files f ON f.id=l.row WHERE f.path!='open.bin'")]:
            e.agent.close_lease(lease)
        e.agent.set_pinned("pinned.bin", True)
        (e.root / "dirty.bin").write_bytes(b"changed")
        e.agent.mark_dirty("dirty.bin")
        (e.root / "edited.bin").write_bytes(b"changed silently, no journal entry")
        (e.root / "user.txt").write_bytes(b"pre-existing")
        e.agent.register([e.fake.put("f_u", "v_1", b"pre-existing", "user.txt")])
        e.agent.open(path="user.txt")
        result = e.agent.evict()
        assert result["evicted"] == ["clean.bin"], result
        for n in names[1:] + ["user.txt"]:
            assert (e.root / n).exists(), n
        assert e.entry("edited.bin")["state"] == "dirty", "silent edit is journaled, not deleted"
        assert e.entry("clean.bin")["state"] == "remote-only"
        assert e.agent.prepare_end()["open"] == ["open.bin", "user.txt"]


def test_space_pressure_blocks_downloads_not_dirty_data():
    with env(reserve_bytes=1000) as e:
        e.agent.register([e.fake.put("f_1", "v_1", b"c" * 400, "cache.bin"), e.fake.put("f_2", "v_1", b"n" * 400, "next.bin")])
        e.agent.close_lease(e.agent.open(path="cache.bin")["leaseId"])
        (e.root / "work.txt").write_bytes(b"unsaved work")
        e.agent.mark_dirty("work.txt")
        e.free = 1200
        expect("insufficient_space", e.agent.open, path="next.bin")
        assert (e.root / "cache.bin").exists() and (e.root / "work.txt").exists() and not (e.root / "next.bin").exists()
    with env(reserve_bytes=1000, auto_evict=True) as e:
        e.agent.register([e.fake.put("f_1", "v_1", b"c" * 400, "cache.bin"), e.fake.put("f_2", "v_1", b"n" * 400, "next.bin")])
        e.agent.close_lease(e.agent.open(path="cache.bin")["leaseId"])
        (e.root / "work.txt").write_bytes(b"unsaved work")
        e.agent.mark_dirty("work.txt")
        real_evict = e.agent.evict
        def evict(need):
            result = real_evict(need)
            e.free += result["freedBytes"]
            return result
        e.agent.evict = evict
        e.free = 1200
        e.agent.open(path="next.bin")
        assert not (e.root / "cache.bin").exists() and (e.root / "work.txt").read_bytes() == b"unsaved work"
        e.free = 100
        expect("insufficient_space", e.agent.open, path="cache.bin")  # nothing clean left; dirty untouched
        assert (e.root / "work.txt").exists()


def test_drain_blocks_new_fetches():
    with env() as e:
        e.agent.register([e.fake.put("f_1", "v_1", b"a", "a.txt"), e.fake.put("f_2", "v_1", b"b", "b.txt")])
        e.agent.open(path="a.txt")
        report = e.agent.prepare_end()
        assert report["ready"] is False and report["open"] == ["a.txt"]
        expect("draining", e.agent.open, path="b.txt")
        e.agent.open(path="a.txt")  # already-local copy still opens
        e.reopen()
        expect("draining", e.agent.open, path="b.txt")  # drain survives restart
        e.agent.resume()
        e.agent.open(path="b.txt")


def child(kind, state, store):
    fake = Fake(store)
    setattr(fake, "crash_in_" + kind, True)
    agent = fa.FilesAgent(state, backend=fake, disk_free=lambda _: 10 << 30)
    agent.open(path="a.txt") if kind == "fetch" else agent.sync()
    raise SystemExit("child survived")


def run_child(e, kind):
    e.agent.close()
    e.agent = None
    proc = subprocess.run([sys.executable, "-B", __file__, "--child", kind, str(e.state), str(e.fake.store)],
                          capture_output=True, text=True, timeout=60)
    assert proc.returncode == 9, proc.stderr
    return e.reopen()


def test_power_loss_and_restart_recovery():
    with env() as e:
        e.agent.register([e.fake.put("f_1", "v_1", b"first version", "a.txt"),
                          e.fake.put("f_2", "v_1", b"b one", "b.txt")])
        e.touch("a.txt")
        e.touch("b.txt")
        e.agent.register([e.fake.put("f_1", "v_2", b"second version!", "a.txt")])
        run_child(e, "fetch")
        assert e.staging() == [], "interrupted download temp removed on restart"
        assert (e.root / "a.txt").read_bytes() == b"first version"
        assert e.entry("a.txt")["baseVersion"] == "v_1" and e.entry("a.txt")["state"] == "clean"
        (e.root / "b.txt").write_bytes(b"my edit before power loss")
        e.agent.mark_dirty("b.txt")
        run_child(e, "commit")  # server committed, agent died before seeing the receipt
        assert e.entry("b.txt")["state"] == "uploading"
        assert e.agent.prepare_end()["unconfirmedOps"], "unknown outcome blocks the end-of-session claim"
        assert "b.txt" not in e.agent.evict()["evicted"] and (e.root / "b.txt").exists()
        assert e.agent.reconcile()["results"][0]["state"] == "clean"
        assert e.fake.body("f_2") == b"my edit before power loss"
        assert e.agent.prepare_end()["ready"] is True and e.staging() == []


def test_cli_json_protocol():
    base = Path(tempfile.mkdtemp(prefix="cb-files-cli-"))
    try:
        (base / "ws").mkdir()
        secret = b"CONTENT-MARKER-should-never-print"
        (base / "ws" / "note.txt").write_bytes(secret)

        def cli(*args):
            proc = subprocess.run([sys.executable, "-B", str(AGENT_PATH), "--state", str(base / "st"), *args],
                                  capture_output=True, timeout=60)
            assert secret not in proc.stdout and secret not in proc.stderr
            lines = proc.stdout.decode("utf-8").strip().splitlines()
            return proc.returncode, (json.loads(lines[-1]) if lines else None)

        assert subprocess.run([sys.executable, "-B", str(AGENT_PATH), "--help"], capture_output=True).returncode == 0
        assert cli("status") == (2, {"ok": False, "code": "not_configured"})
        assert cli("init", "--root", str(base / "ws"), "--workspace-id", "w1", "--machine-id", "m1")[0] == 0
        assert cli("mark-dirty", "--path", "note.txt")[1]["state"] == "dirty"
        assert cli("mark-dirty", "--path", "../x") == (2, {"ok": False, "code": "path_invalid"})
        code, out = cli("sync")
        assert code == 0 and out["results"][0]["code"] == "transport_not_configured"
        code, out = cli("prepare-end", "--flush")
        assert code == 0 and out["ready"] is False and out["uploading"] == ["note.txt"]
        code, out = cli("list-local")
        assert out["items"][0]["evictable"] is False and out["nextCursor"] is None
        assert (base / "ws" / "note.txt").read_bytes() == secret
    finally:
        shutil.rmtree(base, ignore_errors=True)


# ---- real HTTP transport against a loopback core-shaped fake (mock server; not live persistence) ----------
TOKEN = "tok_" + "Q7x" * 14
HTTP_PREFIX = fa.AGENT_PREFIX + "/"


class CoreFake:
    """Core-shaped server state: requestId replay, immutable uploads, canonical commit, writer epoch."""

    def __init__(self):
        self.lock = threading.Lock()
        self.entries = {"root": {"kind": "dir"}}
        self.versions = {}
        self.uploads = {}
        self.replay = {}
        self.local = {}
        self.epoch, self.machine = 1, "m_test"
        self.seen = []
        self.legacy = []
        self.faults = {}
        self.n = 0

    def rid(self, prefix):
        self.n += 1
        return "%s_%04d" % (prefix, self.n)

    def seed(self, path, data, parent="root"):
        file_id, version = self.rid("f"), self.rid("v")
        self.entries[file_id] = {"kind": "file", "parentId": parent, "name": path.rsplit("/", 1)[-1], "current": version}
        self.versions[version] = {"fileId": file_id, "data": data}
        return {"fileId": file_id, "path": path, "versionId": version, "size": len(data), "sha256": sha(data)}

    def seed_dir(self, path, parent="root"):
        dir_id = self.rid("f")
        self.entries[dir_id] = {"kind": "dir", "parentId": parent, "name": path.rsplit("/", 1)[-1], "current": None}
        return {"kind": "dir", "fileId": dir_id, "path": path}

    def uview(self, u):
        return {k: u[k] for k in ("uploadId", "fileId", "baseVersion", "writerEpoch", "size", "sha256", "phase",
                                  "expiresAt", "result")}

    def handle(self, method, route, headers, read_body, query=None):
        if headers.get("authorization") != "Bearer " + TOKEN:
            return 401, {"error": {"code": "capability_invalid"}}
        parts = route.split("/")
        if method == "POST" and route == "create":
            req = json.loads(read_body())
            args = [req["parentId"], unicodedata.normalize("NFC", req["name"]), req["kind"]]
            if req["requestId"] in self.replay:
                op, prev, result = self.replay[req["requestId"]]
                return (200, result) if prev == args else (409, {"error": {"code": "request_conflict"}})
            for e in self.entries.values():
                if e.get("parentId") == req["parentId"] and e["name"].lower() == args[1].lower():
                    return 409, {"error": {"code": "name_conflict"}}
            file_id = self.rid("f")
            self.entries[file_id] = {"kind": req["kind"], "parentId": req["parentId"], "name": args[1], "current": None}
            result = {"entry": {"fileId": file_id, "parentId": req["parentId"], "name": args[1], "kind": req["kind"]}}
            self.replay[req["requestId"]] = ("create", args, result)
            return 200, result
        if method == "POST" and route == "uploads/begin":
            req = json.loads(read_body())
            args = [req[k] for k in ("fileId", "baseVersion", "writerEpoch", "size", "sha256")]
            if req["requestId"] in self.replay:
                op, prev, upload_id = self.replay[req["requestId"]]
                if prev != args:
                    return 409, {"error": {"code": "request_conflict"}}
                return 200, {"upload": self.uview(self.uploads[upload_id])}
            if req["writerEpoch"] != self.epoch:
                return 409, {"error": {"code": "stale_writer"}}
            upload_id = self.rid("u")
            self.uploads[upload_id] = dict(zip(("fileId", "baseVersion", "writerEpoch", "size", "sha256"), args),
                                           uploadId=upload_id, phase="begun", expiresAt=4102444800000,
                                           result=None, data=None)
            self.replay[req["requestId"]] = ("begin", args, upload_id)
            return 200, {"upload": self.uview(self.uploads[upload_id])}
        if method == "PUT" and len(parts) == 3 and parts[0] == "uploads" and parts[2] == "body":
            u = self.uploads[parts[1]]
            data = read_body()
            if int(headers.get("content-length")) != u["size"] or len(data) != u["size"]:
                return 422, {"error": {"code": "size_mismatch"}}
            if sha(data) != u["sha256"]:
                return 422, {"error": {"code": "hash_mismatch"}}
            u["data"], u["phase"] = data, "body_written"
            return 200, {"upload": self.uview(u)}
        if method == "POST" and len(parts) == 3 and parts[0] == "uploads" and parts[2] == "commit":
            u = self.uploads[parts[1]]
            if u["result"]:
                return 200, {"result": u["result"]}
            if u["data"] is None:
                return 422, {"error": {"code": "body_missing"}}
            e = self.entries[u["fileId"]]
            version = self.rid("v")
            self.versions[version] = {"fileId": u["fileId"], "data": u["data"]}
            if u["baseVersion"] == e["current"]:
                e["current"], status, conflict = version, "committed", None
            else:
                status, conflict = "conflict", self.rid("f")
            u["result"] = {"status": status, "fileId": u["fileId"], "versionId": version, "versionSeq": 1,
                           "size": u["size"], "sha256": u["sha256"], "conflictFileId": conflict, "durable": True}
            u["phase"] = status
            return 200, {"result": u["result"]}
        if method == "GET" and len(parts) == 2 and parts[0] == "uploads":
            u = self.uploads.get(parts[1])
            return (200, {"upload": self.uview(u)}) if u else (404, {"error": {"code": "not_found"}})
        if method == "POST" and route == "open":
            req = json.loads(read_body())
            e = self.entries.get(req["fileId"])
            version = req.get("versionId") or (e or {}).get("current")
            v = self.versions.get(version)
            if not e or not v or v["fileId"] != req["fileId"]:
                return 404, {"error": {"code": "not_found"}}
            return 200, {"descriptor": {"fileId": req["fileId"], "versionId": version, "versionSeq": 1, "name": e["name"],
                                        "size": len(v["data"]), "sha256": sha(v["data"]), "committedAt": 1}}
        if method == "GET" and len(parts) == 2 and parts[0] == "content":
            v = self.versions.get((query or {}).get("versionId", [""])[0])
            if not v or v["fileId"] != parts[1]:
                return 404, {"error": {"code": "not_found"}}
            return 200, v["data"]
        if method == "POST" and route == "local-state":
            req = json.loads(read_body())
            if req["writerEpoch"] != self.epoch or req["machineId"] != self.machine:
                return 409, {"error": {"code": "stale_writer"}}
            key = req["fileId"]
            cur = self.local.get(key)
            if cur and cur["seq"] >= req["seq"]:
                return 200, {"local": cur, "applied": False}
            if not req["dirty"] and req["versionId"] != self.entries[key]["current"]:
                return 409, {"error": {"code": "not_verified"}}
            self.local[key] = {k: req[k] for k in ("machineId", "fileId", "versionId", "dirty", "seq")}
            return 200, {"local": self.local[key], "applied": True}
        return 404, {"error": {"code": "not_found"}}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _go(self):
        core = self.server.core
        url = urllib.parse.urlsplit(self.path)
        route = urllib.parse.unquote(url.path[len(HTTP_PREFIX):]) if url.path.startswith(HTTP_PREFIX) else "?"
        query = urllib.parse.parse_qs(url.query)
        headers = {k.lower(): v for k, v in self.headers.items()}
        cached = []

        def read_body():
            if not cached:
                cached.append(self.rfile.read(int(headers.get("content-length") or 0)))
            return cached[0]
        with core.lock:
            core.seen.append((self.command, route, headers))
            if route.startswith("versions/"):
                core.legacy.append(route)
            kind = "uploads" if route.startswith("uploads/") and route != "uploads/begin" else route
            fault = core.faults.pop((self.command, kind), None)
            if fault == "drop_before":
                read_body()
                return
            if fault == "redirect":
                read_body()
                self.send_response(302)
                self.send_header("location", "http://198.51.100.7/steal")
                self.end_headers()
                return
            status, body = core.handle(self.command, route, headers, read_body, query)
            if callable(fault):
                status, body = fault(status, body)
            if fault == "drop_after":
                return  # processed, but the reply is lost
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/octet-stream" if isinstance(body, bytes) else "application/json")
        self.send_header("content-length", str(len(raw)))
        if isinstance(body, bytes):
            self.send_header("x-cloudbite-sha256", sha(body))
            self.send_header("x-cloudbite-version", query.get("versionId", [""])[0])
        self.end_headers()
        self.wfile.write(raw)

    do_GET = do_POST = do_PUT = _go


@contextlib.contextmanager
def http_env(**cap):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.core = CoreFake()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = tempfile.mkdtemp(prefix="cb-files-http-")
    ns = None
    try:
        root, state = Path(base) / "workspace", Path(base) / "state"
        root.mkdir()
        fa.FilesAgent.init(str(state), str(root), "w_test", "m_test", reserve_bytes=0).close()
        config = {"schema": fa.CAPABILITY_SCHEMA,
                  "endpoint": "http://127.0.0.1:%d%s" % (server.server_address[1], fa.AGENT_PREFIX),
                  "token": TOKEN, "machineId": "m_test", "workspaceId": "w_test", "writerEpoch": 1,
                  "expiresAt": int(time.time() * 1000) + 3600_000}
        config.update(cap)
        cap_path = Path(base) / "capability.json"
        cap_path.write_text(json.dumps(config))
        if os.name != "nt":
            os.chmod(cap_path, 0o600)
        ns = types.SimpleNamespace(core=server.core, root=root, state=state, cap=cap_path, config=config, agent=None)
        ns.open_agent = lambda: fa.FilesAgent(str(state), backend=fa.HttpBackend.load(str(cap_path)),
                                              disk_free=lambda _: 10 << 30)
        yield ns
    finally:
        if ns and ns.agent:
            ns.agent.close()
        server.shutdown()
        server.server_close()
        shutil.rmtree(base, ignore_errors=True)


def entry_of(agent, path):
    return next(i for i in agent.list_local(0, 500)["items"] if i["path"] == path)


def test_http_roundtrip_create_open_upload_report():
    with http_env() as h:
        h.agent = a = h.open_agent()
        docs = h.core.seed_dir("docs")
        seeded = h.core.seed("docs/a.txt", b"remote one", parent=docs["fileId"])
        a.register([docs, seeded])
        opened = a.open(path="docs/a.txt")
        assert opened["fetchedBytes"] == 10 and (h.root / "docs/a.txt").read_bytes() == b"remote one"
        (h.root / "docs/a.txt").write_bytes(b"local two")
        a.mark_dirty("docs/a.txt")
        (h.root / "docs/new.txt").write_bytes(b"brand new")
        a.mark_dirty("docs/new.txt")
        results = a.sync()["results"]
        assert [r["state"] for r in results] == ["clean", "clean"], results
        new_id = entry_of(a, "docs/new.txt")["fileId"]
        assert h.core.entries[new_id]["parentId"] == docs["fileId"] and h.core.entries[new_id]["name"] == "new.txt"
        assert h.core.versions[h.core.entries[seeded["fileId"]]["current"]]["data"] == b"local two"
        reports = a.report_local()["results"]
        assert len(reports) == 2 and all(r["applied"] and not r["dirty"] for r in reports), reports
        assert a.report_local()["results"] == [], "acknowledged state is not resent"
        made = a.create_dir("docs/sub")
        assert made["created"] and h.core.entries[made["dirId"]]["kind"] == "dir"
        assert a.prepare_end()["open"] == ["docs/a.txt"]
        for method, route, headers in h.core.seen:
            assert headers["authorization"] == "Bearer " + TOKEN
            assert "cookie" not in headers and "origin" not in headers
        out = json.dumps([results, reports, made, a.status(), repr(a.backend)])
        assert TOKEN not in out and TOKEN[4:20] not in out


def test_http_unknown_outcomes_reconcile_with_same_ids():
    with http_env() as h:
        h.agent = a = h.open_agent()
        seeded = h.core.seed("a.txt", b"one")
        a.register([seeded])
        a.open(path="a.txt")
        (h.root / "a.txt").write_bytes(b"two")
        a.mark_dirty("a.txt")
        h.core.faults[("POST", "uploads")] = "drop_after"  # commit lands, reply lost
        lost = a.sync()["results"][0]
        assert lost["phase"] == "unknown" and entry_of(a, "a.txt")["state"] == "uploading"
        assert a.prepare_end()["ready"] is False
        a.resume()
        assert a.reconcile()["results"][0]["state"] == "clean"
        assert len(h.core.uploads) == 1
        # begin reply lost: no uploadId known, resend same requestId -> server replays the same upload
        (h.root / "a.txt").write_bytes(b"three")
        a.mark_dirty("a.txt")
        h.core.faults[("POST", "uploads/begin")] = "drop_after"
        first = a.sync()["results"][0]
        assert first["phase"] == "unknown" and a._op(first["requestId"])["upload_id"] is None
        assert a.reconcile()["results"][0]["phase"] == "prepared"
        again = a.sync()["results"][0]
        assert again["requestId"] == first["requestId"] and again["state"] == "clean"
        assert len(h.core.uploads) == 2, "one upload per request id"
        # body PUT reply lost: GET upload says body_written -> resend same id, commit once
        (h.root / "a.txt").write_bytes(b"four")
        a.mark_dirty("a.txt")
        h.core.faults[("PUT", "uploads")] = "drop_after"
        third = a.sync()["results"][0]
        assert third["phase"] == "unknown"
        assert a.reconcile()["results"][0]["phase"] == "prepared"
        assert a.sync()["results"][0]["state"] == "clean" and len(h.core.uploads) == 3
        # new file whose create reply is lost: derived create requestId replays, no duplicate entry
        (h.root / "n.txt").write_bytes(b"new")
        a.mark_dirty("n.txt")
        h.core.faults[("POST", "create")] = "drop_after"
        assert a.sync()["results"][0]["phase"] == "unknown"
        a.reconcile()
        assert a.sync()["results"][0]["state"] == "clean"
        assert sum(1 for e in h.core.entries.values() if e.get("name") == "n.txt") == 1
        # redirect is never followed and leaves the outcome unknown
        (h.root / "n.txt").write_bytes(b"newer")
        a.mark_dirty("n.txt")
        h.core.faults[("POST", "uploads/begin")] = "redirect"
        before = len(h.core.seen)
        assert a.sync()["results"][0]["phase"] == "unknown"
        assert len(h.core.seen) == before + 1, "no follow-up request to the redirect target"


def test_http_malformed_and_conflicting_receipts_preserve_dirty():
    def tamper(**changes):
        def fault(status, body):
            return status, dict(body, result=dict(body["result"], **changes))
        return fault
    with http_env() as h:
        h.agent = a = h.open_agent()
        a.register([h.core.seed("a.txt", b"one")])
        a.open(path="a.txt")
        for changes in ({"sha256": "0" * 64}, {"durable": False}, {"size": 999}, {"fileId": "f_other"},
                        {"status": "weird"}):
            (h.root / "a.txt").write_bytes(b"edit %r" % sorted(changes))
            a.mark_dirty("a.txt")
            h.core.faults[("POST", "uploads")] = tamper(**changes)
            result = a.sync()["results"][0]
            assert result["phase"] == "unknown", (changes, result)
            assert entry_of(a, "a.txt")["state"] == "uploading"
            assert a.reconcile()["results"][0]["state"] == "clean"  # GET upload has the true receipt
        # someone else advanced the file: canonical conflict result -> local conflict, bytes kept
        file_id = entry_of(a, "a.txt")["fileId"]
        h.core.entries[file_id]["current"] = "v_elsewhere"
        (h.root / "a.txt").write_bytes(b"mine")
        a.mark_dirty("a.txt")
        assert a.sync()["results"][0]["phase"] == "conflict"
        assert entry_of(a, "a.txt")["state"] == "conflict" and (h.root / "a.txt").read_bytes() == b"mine"
        assert a.prepare_end()["safeToDelete"] is False


def test_http_stale_epoch_expiry_and_scope_fail_closed():
    with http_env() as h:
        h.agent = a = h.open_agent()
        a.register([h.core.seed("a.txt", b"one")])
        a.open(path="a.txt")
        (h.root / "a.txt").write_bytes(b"after takeover")
        a.mark_dirty("a.txt")
        h.core.epoch = 2  # another machine became the writer
        assert a.sync()["results"][0]["code"] == "stale_writer"
        assert entry_of(a, "a.txt")["state"] == "conflict" and (h.root / "a.txt").read_bytes() == b"after takeover"
        assert a.report_local()["results"][0]["code"] == "stale_writer"
        a.close()
        h.agent = None
    with http_env(expiresAt=1) as h:
        h.agent = a = h.open_agent()
        (h.root / "b.txt").write_bytes(b"local")
        a.mark_dirty("b.txt")
        assert a.sync()["results"][0]["code"] == "capability_expired"
        assert h.core.seen == [], "expired capability sends nothing"
    for bad in ({"writerEpoch": 2}, {"machineId": "m_other"}, {"workspaceId": "w_other"}):
        with http_env(**bad) as h:
            expect("scope_mismatch", h.open_agent)
    pre = fa.AGENT_PREFIX
    for bad in ({"endpoint": "http://198.51.100.7" + pre}, {"endpoint": "https://u:p@x.example" + pre},
                {"endpoint": "https://x.example"}, {"endpoint": "https://x.example/"},
                {"endpoint": "https://x.example/api/cloudbite/computer/files/agent/v1"},
                {"endpoint": "https://x.example" + pre + "/"}, {"endpoint": "https://x.example" + pre + "?a=1"},
                {"endpoint": "https://x.example" + pre + "#f"}, {"endpoint": "https://x.example" + pre + "?"},
                {"endpoint": "ftp://x.example" + pre}, {"endpoint": None}, {"token": "short"},
                {"schema": "other"}, {"expiresAt": "soon"}):
        with http_env(**bad) as h:
            expect("capability_invalid", fa.HttpBackend.load, str(h.cap))
    with http_env() as h:
        if os.name == "nt":
            SKIPS.append("capability file 0600/owner check (Windows host)")
        else:
            os.chmod(h.cap, 0o644)
            expect("capability_insecure", fa.HttpBackend.load, str(h.cap))


def test_http_names_parents_and_collisions_are_conservative():
    with http_env() as h:
        h.agent = a = h.open_agent()
        expect("path_ambiguous", a.register, [h.core.seed("Straße.txt", b"x")])
        expect("path_ambiguous", a.register, [h.core.seed_dir("ΟΔΟΣ")])
        docs = h.core.seed_dir("docs")
        a.register([docs])
        expect("path_collision", a.register, [h.core.seed("DOCS", b"x")])
        (h.root / "loose").mkdir()
        (h.root / "loose" / "x.txt").write_bytes(b"x")
        a.mark_dirty("loose/x.txt")
        (h.root / "Maße.txt").write_bytes(b"y")
        a.mark_dirty("Maße.txt")
        codes = sorted(r.get("code") for r in a.sync()["results"])
        assert codes == ["parent_not_registered", "path_ambiguous"], codes
        assert {entry_of(a, p)["state"] for p in ("loose/x.txt", "Maße.txt")} == {"dirty"}
        assert not any(m == "POST" and r == "create" for m, r, _ in h.core.seen), "nothing created remotely"
        expect("parent_not_registered", a.create_dir, "loose/deeper")
        # remote name already taken by an unregistered sibling: conflict, local bytes kept
        h.core.seed("taken.txt", b"server")
        (h.root / "TAKEN.txt").write_bytes(b"mine")
        a.mark_dirty("TAKEN.txt")
        assert "name_conflict" in [r.get("code") for r in a.sync()["results"]]
        assert entry_of(a, "TAKEN.txt")["state"] == "conflict"


def test_http_cli_never_prints_capability():
    with http_env() as h:
        (h.root / "note.txt").write_bytes(b"CONTENT-MARKER")

        def cli(*args):
            proc = subprocess.run([sys.executable, "-B", str(AGENT_PATH), "--state", str(h.state), "--capability",
                                   str(h.cap), *args], capture_output=True, timeout=60)
            for blob in (proc.stdout, proc.stderr):
                assert TOKEN.encode() not in blob and b"CONTENT-MARKER" not in blob
            return proc.returncode, json.loads(proc.stdout.decode("utf-8").strip().splitlines()[-1])
        assert cli("mark-dirty", "--path", "note.txt")[1]["state"] == "dirty"
        code, out = cli("sync")
        assert code == 0 and out["results"][0]["state"] == "clean", out
        assert cli("report-local")[1]["results"][0]["applied"] is True
        assert cli("status")[1]["transportConfigured"] is True
        h.cap.write_text("{not json")
        assert cli("status") == (2, {"ok": False, "code": "capability_invalid"})


def test_growing_file_snapshot_is_bounded_per_chunk():
    # Limit: the first stat says 50 bytes, the writer keeps appending while the snapshot is copied.
    with env(max_transfer_bytes=100, reserve_bytes=0) as e:
        (e.root / "log.txt").write_bytes(b"a" * 50)
        e.agent.mark_dirty("log.txt")

        def grow(_):
            with open(e.root / "log.txt", "ab") as handle:
                handle.write(b"b" * 200)
            return 10 << 30
        e.agent.disk_free = grow
        assert e.agent.sync()["results"] == [{"path": "log.txt", "code": "transfer_too_large"}]
        assert e.staging() == [] and e.entry("log.txt")["state"] == "dirty"
        assert e.agent.prepare_end()["unconfirmedOps"] == [] and e.fake._load()["ops"] == {}
    # Reserve: free space shrinks while staging; copying stops before crossing the reserve.
    old_chunk = fa.CHUNK
    fa.CHUNK = 16
    try:
        with env(reserve_bytes=100) as e:
            (e.root / "big.bin").write_bytes(b"z" * 64)
            e.agent.mark_dirty("big.bin")
            with open(e.root / "big.bin", "ab") as handle:
                handle.write(b"z" * 1000)  # grew after the dirty mark, before the snapshot
            free = [200]

            def shrinking(_):
                free[0] -= 16
                return free[0]
            e.agent.disk_free = shrinking
            assert e.agent.sync()["results"] == [{"path": "big.bin", "code": "insufficient_space"}]
            assert e.staging() == [] and e.entry("big.bin")["state"] == "dirty"
            assert (e.root / "big.bin").stat().st_size == 1064, "local bytes untouched"
            e.agent.disk_free = lambda _: 10 << 30
            assert e.agent.sync()["results"][0]["state"] == "clean"
            assert e.fake.body(e.entry("big.bin")["fileId"]) == b"z" * 1064
    finally:
        fa.CHUNK = old_chunk


def test_open_with_lease_id_is_idempotent():
    with env() as e:
        e.agent.register([e.fake.put("f_1", "v_1", b"one", "a.txt"), e.fake.put("f_2", "v_1", b"two", "b.txt")])
        lease = "0f8fad5bd9cb469fa16570867728950e"
        first = e.agent.open(path="a.txt", lease_id=lease)
        again = e.agent.open(file_id="f_1", version="v_1", lease_id=lease)
        assert first["leaseId"] == again["leaseId"] == lease and again["replayed"] is True and again["fetchedBytes"] == 0
        assert e.fake.fetches == 1 and e.agent.status()["openLeases"] == 1, "a retried open takes no second lease"
        expect("request_conflict", e.agent.open, path="b.txt", lease_id=lease)
        for bad in ("A" * 32, "a" * 31, "x" * 32, 7):
            expect("invalid_argument", e.agent.open, path="b.txt", lease_id=bad)
        e.agent.close_lease(lease)
        assert e.agent.status()["openLeases"] == 0 and e.agent.prepare_end()["open"] == []
        expect("not_found", e.agent.close_lease, lease)


def test_http_backend_eviction_is_gated_and_keeps_clean_files():
    # Regression: an HTTP-backed agent must not evict even a verified clean, unpinned, closed agent copy (explicit
    # evict, auto-evict and the CLI), because server pins and live persistence are not yet proven to reach this agent.
    with http_env() as h:
        h.agent = a = h.open_agent()
        seeded = h.core.seed("clean.bin", b"c" * 400)
        a.register([seeded])
        a.close_lease(a.open(path="clean.bin")["leaseId"])
        item = entry_of(a, "clean.bin")
        assert item["state"] == "clean" and item["origin"] == "agent" and not item["pinned"] and not item["open"]
        assert item["evictable"] is False and a.status()["eviction"] == "gated"
        expect("eviction_gated", a.evict)
        expect("eviction_gated", a.evict, 1)
        assert (h.root / "clean.bin").read_bytes() == b"c" * 400 and entry_of(a, "clean.bin")["state"] == "clean"
        a.cfg["autoEvict"], a.cfg["reserveBytes"] = True, 1000
        a.disk_free = lambda _: 100
        a.register([h.core.seed("next.bin", b"n" * 50)])
        expect("insufficient_space", a.open, path="next.bin")
        assert (h.root / "clean.bin").exists() and not (h.root / "next.bin").exists()
        a.close()
        h.agent = None
        proc = subprocess.run([sys.executable, "-B", str(AGENT_PATH), "--state", str(h.state), "--capability", str(h.cap),
                               "evict"], capture_output=True, timeout=60)
        assert proc.returncode == 2 and json.loads(proc.stdout.decode().strip()) == {"ok": False, "code": "eviction_gated"}
        assert TOKEN.encode() not in proc.stdout + proc.stderr
        assert (h.root / "clean.bin").read_bytes() == b"c" * 400
    with env() as e:
        e.agent.register([e.fake.put("f_1", "v_1", b"x" * 10, "x.bin")])
        e.agent.close_lease(e.agent.open(path="x.bin")["leaseId"])
        e.reopen(fa.UnconfiguredHttpBackend())
        expect("eviction_gated", e.agent.evict)
        assert (e.root / "x.bin").exists()


def test_http_open_descriptor_gates_content_fetch():
    with http_env() as h:
        h.agent = a = h.open_agent()
        seeded = h.core.seed("a.txt", b"remote one")
        a.register([seeded])
        a.open(path="a.txt")
        routes = [(m, r) for m, r, _ in h.core.seen]
        assert routes == [("POST", "open"), ("GET", "content/" + seeded["fileId"])], routes
        assert h.core.legacy == [], "no versions/<f>/<v>/content route"
        b = h.core.seed("b.txt", b"bee")
        a.register([b])
        for tamper in ({"sha256": "0" * 64}, {"size": 4}, {"versionId": "v_9999"}):
            h.core.faults[("POST", "open")] = lambda s, body, t=tamper: (s, {"descriptor": dict(body["descriptor"], **t)})
            before = len(h.core.seen)
            expect("version_mismatch", a.open, path="b.txt")
            assert len(h.core.seen) == before + 1, "no content request after a descriptor mismatch"
            assert not (h.root / "b.txt").exists() and os.listdir(h.state / "staging") == []
        h.core.faults[("GET", "content/" + b["fileId"])] = lambda s, body: (s, b"bez")
        expect("checksum_mismatch", a.open, path="b.txt")
        assert not (h.root / "b.txt").exists()
        a.open(path="b.txt")
        assert (h.root / "b.txt").read_bytes() == b"bee"


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--child":
        child(*sys.argv[2:5])
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for test in tests:
        test()
        print("ok", test.__name__)
    for skip in SKIPS:
        print("skip", skip)
    print("cloudbite-computer-files-agent: %d tests passed, %d skips" % (len(tests), len(SKIPS)))
