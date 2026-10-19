#!/usr/bin/env python3
"""Bounded, replayable storage capability probe for CloudBite files (plan P0-A).

    python tools/cloudbite-files-storage-probe.py --dry-run
    python tools/cloudbite-files-storage-probe.py --live --ledger LEDGER.json
    python tools/cloudbite-files-storage-probe.py --reconcile --ledger LEDGER.json
    python tools/cloudbite-files-storage-probe.py --cleanup --ledger LEDGER.json
    python tools/cloudbite-files-storage-probe.py --matrix write|verify --root DIR   (runs inside the machine)

--live creates at most one uniquely named Daytona Volume and one small CPU sandbox that
mounts it, runs the file matrix on the Volume and on the machine's local disk, stops and
starts the machine, verifies the same bytes, and deletes only what the ledger proves it
created.  Every create is written to the ledger as an intent *before* the call; an
unknown create result is reconciled by exact name/label lookup and never re-sent.
Quota or 401/403 refusals are recorded as results and stop the run; the probe uses
DAYTONA_API_KEY only and never switches account.  The key is read from the environment
and never written to the ledger, argv or output.
"""
import argparse
import hashlib
import json
import os
import sys
import time
import uuid

PREFIX = "cbfs-probe-"
OWNER_LABEL = "cloudbite-files-storage-probe"
MOUNT = "/home/daytona/cbfs"
LOCAL = "/home/daytona/cbfs-local"
REMOTE_SCRIPT = "/tmp/cbfs_matrix.py"
LIMITS = {"maxBytes": 2 * 1024 ** 3, "maxSandboxes": 1, "maxVolumes": 1, "ttlMinutes": 60, "gpu": 0}
DEFAULT_PLAN = {"cpu": 1, "memoryGiB": 1, "diskGiB": 3, "ttlMinutes": 60, "autoStopMinutes": 20,
                "autoDeleteMinutes": 30, "bigFileMiB": 32, "region": None}


# ---------------------------------------------------------------- file matrix
# Runs inside the sandbox (stdlib only) and locally in the tests.  Each check records
# what happened; an unsupported operation is reported as such, never as a pass.

def _stream(seed, size):
    out, counter = bytearray(), 0
    while len(out) < size:
        out += hashlib.sha256(("%s:%d" % (seed, counter)).encode()).digest() * 64
        counter += 1
    return bytes(out[:size])


def _sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _mount_of(root):
    best = None
    try:
        with open("/proc/mounts", encoding="utf8") as f:
            for line in f:
                dev, point, fstype, opts = line.split()[:4]
                point = point.replace("\\040", " ")
                if (root == point or root.startswith(point.rstrip("/") + "/")) and (not best or len(point) > len(best["point"])):
                    best = {"point": point, "fstype": fstype, "device": dev, "options": opts}
    except OSError:
        pass
    return best


def _check(results, name, fn):
    t = time.perf_counter()
    try:
        value = fn()
        results[name] = {"ok": True, "ms": round((time.perf_counter() - t) * 1000, 2), "value": value}
    except Exception as exc:  # recorded per check; the matrix continues
        results[name] = {"ok": False, "ms": round((time.perf_counter() - t) * 1000, 2),
                         "error": "%s: %s" % (type(exc).__name__, str(exc)[:200])}


def matrix_write(root, big_mib=32):
    os.makedirs(root, exist_ok=True)
    r, files = {}, {}
    uni_dir = os.path.join(root, "한글 폴더")
    uni = os.path.join(uni_dir, "파일 ✓ é.txt")
    small = os.path.join(root, "small.txt")
    big = os.path.join(root, "big.bin")
    big_bytes = _stream("cbfs", big_mib * 1024 * 1024)

    def write_small():
        with open(small, "wb") as f:
            f.write(b"cloudbite storage probe\n")
            f.flush()
            os.fsync(f.fileno())
        return os.path.getsize(small)

    def write_big():
        t = time.perf_counter()
        with open(big, "wb") as f:
            for i in range(0, len(big_bytes), 1 << 20):
                f.write(big_bytes[i:i + (1 << 20)])
            f.flush()
            w = time.perf_counter()
            os.fsync(f.fileno())
        done = time.perf_counter()
        return {"bytes": len(big_bytes), "writeMs": round((w - t) * 1000, 1), "fsyncMs": round((done - w) * 1000, 1)}

    def unicode_path():
        os.makedirs(uni_dir, exist_ok=True)
        with open(uni, "w", encoding="utf8") as f:
            f.write("한글 내용\n")
        return sorted(os.listdir(uni_dir))

    def empty_dir():
        os.makedirs(os.path.join(root, "empty"), exist_ok=True)
        return os.listdir(os.path.join(root, "empty"))

    def rename():
        a, b = os.path.join(root, "rename-a.txt"), os.path.join(uni_dir, "rename-b.txt")
        with open(a, "w") as f:
            f.write("rename")
        os.replace(a, b)
        return {"sourceGone": not os.path.exists(a), "target": os.path.exists(b)}

    def rename_over_existing():
        a, b = os.path.join(root, "over-a.txt"), os.path.join(root, "over-b.txt")
        for p, text in ((a, "new"), (b, "old")):
            with open(p, "w") as f:
                f.write(text)
        os.replace(a, b)
        return open(b).read()

    def rename_dir():
        a, b = os.path.join(root, "dir-a"), os.path.join(root, "dir-b")
        os.makedirs(os.path.join(a, "child"), exist_ok=True)
        os.replace(a, b)
        return os.path.isdir(os.path.join(b, "child"))

    def range_read():
        with open(big, "rb") as f:
            out = []
            for off in (0, 4097, len(big_bytes) // 2, len(big_bytes) - 100):
                f.seek(off)
                out.append(f.read(100) == big_bytes[off:off + 100])
        return all(out)

    def overwrite_middle():
        with open(small, "r+b") as f:
            f.seek(10)
            f.write(b"STORAGE")
            f.flush()
            os.fsync(f.fileno())
        return open(small, "rb").read().decode()

    def append():
        with open(small, "ab") as f:
            f.write(b"appended\n")
        return os.path.getsize(small)

    def truncate():
        p = os.path.join(root, "truncate.bin")
        with open(p, "wb") as f:
            f.write(b"x" * 4096)
        os.truncate(p, 100)
        return os.path.getsize(p)

    def delete():
        p = os.path.join(root, "delete-me.txt")
        open(p, "w").close()
        os.remove(p)
        return not os.path.exists(p)

    def chmod():
        os.chmod(small, 0o640)
        return oct(os.stat(small).st_mode & 0o777)

    def utime():
        os.utime(small, (1_700_000_000, 1_700_000_000))
        return int(os.stat(small).st_mtime)

    def symlink():
        p = os.path.join(root, "link")
        if os.path.lexists(p):
            os.remove(p)
        os.symlink("small.txt", p)
        return os.readlink(p)

    def hardlink():
        p = os.path.join(root, "hard")
        if os.path.exists(p):
            os.remove(p)
        os.link(small, p)
        return os.stat(small).st_nlink

    def lock():
        import fcntl
        with open(small, "rb") as f:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)
        return True

    def dir_fsync():
        fd = os.open(root, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        return True

    for name, fn in (("writeSmallFsync", write_small), ("writeBigFsync", write_big), ("unicodePath", unicode_path),
                     ("emptyDir", empty_dir), ("renameFileAcrossDir", rename), ("renameOverExisting", rename_over_existing),
                     ("renameDir", rename_dir), ("rangeRead", range_read), ("overwriteMiddle", overwrite_middle),
                     ("append", append), ("truncate", truncate), ("delete", delete), ("chmod", chmod), ("utime", utime),
                     ("symlink", symlink), ("hardlink", hardlink), ("flock", lock), ("dirFsync", dir_fsync)):
        _check(r, name, fn)
    for p in (small, big, uni):
        if os.path.exists(p):
            files[os.path.relpath(p, root).replace(os.sep, "/")] = {"size": os.path.getsize(p), "sha256": _sha(p)}
    manifest = {"files": files, "dirs": ["empty", "한글 폴더", "dir-b/child"], "expectedBigSha256": hashlib.sha256(big_bytes).hexdigest()}
    with open(os.path.join(root, ".cbfs-manifest.json"), "w", encoding="utf8") as f:
        json.dump(manifest, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    return {"mode": "write", "root": root, "mount": _mount_of(root), "checks": r, "manifest": manifest}


def matrix_verify(root):
    with open(os.path.join(root, ".cbfs-manifest.json"), encoding="utf8") as f:
        manifest = json.load(f)
    files = {}
    for rel, want in manifest["files"].items():
        p = os.path.join(root, *rel.split("/"))
        t = time.perf_counter()
        got = {"exists": os.path.exists(p)}
        if got["exists"]:
            got.update(size=os.path.getsize(p), sha256=_sha(p))
        got["match"] = got.get("sha256") == want["sha256"] and got.get("size") == want["size"]
        got["readMs"] = round((time.perf_counter() - t) * 1000, 1)
        files[rel] = got
    dirs = {d: os.path.isdir(os.path.join(root, *d.split("/"))) for d in manifest["dirs"]}
    ok = all(v["match"] for v in files.values()) and all(dirs.values())
    return {"mode": "verify", "root": root, "mount": _mount_of(root), "files": files, "dirs": dirs, "ok": ok}


# ---------------------------------------------------------------- ledger and safety

class Refused(Exception):
    """The account or plan refused the step (quota, 401/403, budget); recorded, not retried."""


class Unknown(Exception):
    """A create's outcome is unknown; reconcile by lookup, never re-send."""


def classify(exc):
    status = getattr(exc, "status_code", None)
    name = type(exc).__name__.lower()
    text = str(exc).lower()
    if status in (401, 402, 403) or "quota" in text or "limit exceeded" in text or "forbidden" in name:
        return "refused"
    if status is None and ("timeout" in name or "connection" in name):
        return "unknown"
    if status is None or status >= 500 or status == 429:
        return "unknown"
    return "failed"


def redact(exc):
    msg = str(exc)
    for var in ("DAYTONA_API_KEY",):
        secret = os.environ.get(var)
        if secret:
            msg = msg.replace(secret, "<redacted>")
    return {"type": type(exc).__name__, "status": getattr(exc, "status_code", None),
            "code": getattr(exc, "code", None), "message": msg[:300]}


class Ledger:
    def __init__(self, path, data):
        self.path, self.data = path, data

    @classmethod
    def open(cls, path, run_id=None):
        if os.path.exists(path):
            with open(path, encoding="utf8") as f:
                return cls(path, json.load(f))
        run_id = run_id or uuid.uuid4().hex[:12]
        return cls(path, {"schema": "cloudbite.files-storage-probe.v1", "runId": run_id, "name": PREFIX + run_id,
                          "account": "env:DAYTONA_API_KEY", "limits": LIMITS, "createdAt": _now(),
                          "resources": [], "steps": [], "result": None})

    def save(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf8") as f:
            json.dump(self.data, f, indent=2, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)

    def resource(self, kind):
        return next((r for r in self.data["resources"] if r["kind"] == kind), None)

    def step(self, name, **fields):
        self.data["steps"].append({"step": name, "at": _now(), **fields})
        self.save()


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def check_plan(plan):
    if plan.get("gpu"):
        raise Refused("plan requests a GPU")
    if plan["ttlMinutes"] > LIMITS["ttlMinutes"] or plan["ttlMinutes"] <= 0:
        raise Refused("sandbox ttl must be 1..%d minutes" % LIMITS["ttlMinutes"])
    data = plan["bigFileMiB"] * 1024 * 1024 * 2 + 1024 * 1024  # volume + local copy + small files
    if data > LIMITS["maxBytes"]:
        raise Refused("synthetic data %d bytes exceeds %d" % (data, LIMITS["maxBytes"]))
    return data


def owned(ledger, kind, found):
    """found is the provider's view: {id, name, labels?}. True only if the ledger proves we created it."""
    rec = ledger.resource(kind)
    name = ledger.data["name"]
    if not rec or not rec.get("id") or not found or found.get("id") != rec["id"]:
        return False
    if rec.get("name") != name or found.get("name") != name or not name.startswith(PREFIX):
        return False
    if kind == "sandbox":
        labels = found.get("labels") or {}
        return labels.get("cbfs-probe-run") == ledger.data["runId"] and labels.get("owner") == OWNER_LABEL
    return True


def create(ledger, kind, provider, do_create, find):
    """Intent persisted before the call; unknown outcomes reconciled by lookup, never re-sent."""
    rec = ledger.resource(kind)
    if rec and rec.get("id"):
        return rec
    if rec and rec["state"] in ("intent", "unknown"):
        found = find()
        if found:
            rec.update(id=found["id"], state="created", reconciled=True)
            ledger.save()
            return rec
        rec["state"] = "unknown"
        ledger.save()
        raise Unknown("%s create outcome unknown and not found by lookup; not re-sent" % kind)
    rec = {"kind": kind, "name": ledger.data["name"], "state": "intent", "intentAt": _now()}
    ledger.data["resources"].append(rec)
    ledger.save()
    try:
        made = do_create()
    except Exception as exc:
        kind_of = classify(exc)
        rec["error"] = redact(exc)
        if kind_of == "refused":
            rec["state"] = "refused"
            ledger.save()
            raise Refused("%s create refused by account: %s" % (kind, rec["error"]["message"][:120]))
        if kind_of == "failed":
            rec["state"] = "failed"
            ledger.save()
            raise
        rec["state"] = "unknown"
        ledger.save()
        found = find()
        if found:
            rec.update(id=found["id"], state="created", reconciled=True)
            ledger.save()
            return rec
        raise Unknown("%s create outcome unknown and not found by lookup; not re-sent" % kind)
    rec.update(id=made["id"], state="created", createdAt=_now(), detail=made.get("detail"))
    ledger.save()
    return rec


def cleanup(ledger, provider, only_after_proof=True):
    """Delete only resources the ledger proves were created by this run."""
    out = {}
    proof = ledger.data.get("proof") or {}
    sb = ledger.resource("sandbox")
    if sb and sb.get("id") and sb["state"] != "deleted":
        found = provider.sandbox_get(sb["id"])
        if found is None:
            sb["state"] = "deleted"
            out["sandbox"] = "already-absent"
        elif not owned(ledger, "sandbox", found):
            out["sandbox"] = "refused-not-owned"
        else:
            try:
                provider.sandbox_delete(sb["id"])
                sb.update(state="deleted", deletedAt=_now())
                out["sandbox"] = "deleted"
            except Exception as exc:
                sb["deleteError"] = redact(exc)
                out["sandbox"] = "delete-uncertain"
        ledger.save()
    vol = ledger.resource("volume")
    if vol and vol.get("id") and vol["state"] != "deleted":
        if only_after_proof and not proof.get("verified") and not proof.get("aborted"):
            out["volume"] = "kept-no-proof"
        else:
            found = provider.volume_get(vol["id"])
            if found is None:
                vol["state"] = "deleted"
                out["volume"] = "already-absent"
            elif not owned(ledger, "volume", found):
                out["volume"] = "refused-not-owned"
            else:
                deadline = time.time() + provider.delete_wait
                while True:
                    try:
                        provider.volume_delete(vol["id"])
                        vol.update(state="deleted", deletedAt=_now())
                        out["volume"] = "deleted"
                        break
                    except Exception as exc:  # 409 while the sandbox detaches
                        vol["deleteError"] = redact(exc)
                        if getattr(exc, "status_code", None) != 409 or time.time() > deadline:
                            out["volume"] = "delete-uncertain"
                            break
                        provider.sleep(5)
        ledger.save()
    ledger.step("cleanup", outcome=out)
    return out


# ---------------------------------------------------------------- live run

def run_live(ledger, provider, plan, matrix_source):
    data_bytes = check_plan(plan)
    ledger.data["plan"] = plan
    ledger.save()
    name, run_id = ledger.data["name"], ledger.data["runId"]
    try:
        vols = provider.volume_list()
        ledger.step("preflight", volumeCount=len(vols), syntheticBytes=data_bytes,
                    nameCollision=any(v["name"] == name for v in vols) and not ledger.resource("volume"))
        if ledger.data["steps"][-1]["nameCollision"]:
            raise Refused("a volume named %s already exists and is not in this ledger" % name)

        vol = create(ledger, "volume", provider, lambda: provider.volume_create(name), lambda: provider.volume_find(name))
        state = provider.wait_volume_ready(vol["id"])
        ledger.step("volumeReady", state=state)
        if state != "ready":
            raise Refused("volume did not become ready: %s" % state)

        spec = {"name": name, "labels": {"cbfs-probe-run": run_id, "owner": OWNER_LABEL},
                "cpu": plan["cpu"], "memory": plan["memoryGiB"], "disk": plan["diskGiB"], "gpu": 0,
                "ttlMinutes": plan["ttlMinutes"], "autoStopMinutes": plan["autoStopMinutes"],
                "autoDeleteMinutes": plan["autoDeleteMinutes"], "region": plan.get("region"),
                "volumes": [{"volumeId": vol["id"], "mountPath": MOUNT}]}
        sb = create(ledger, "sandbox", provider, lambda: provider.sandbox_create(spec),
                    lambda: provider.sandbox_find(run_id, name))
        sid = sb["id"]
        provider.upload(sid, matrix_source.encode("utf8"), REMOTE_SCRIPT)
        vroot, lroot = "%s/%s" % (MOUNT, run_id), "%s/%s" % (LOCAL, run_id)
        env = provider.exec(sid, "python3 -c 'import sys,platform;print(sys.version.split()[0], platform.machine())'; "
                            "id -u; df -B1 --output=size,avail %s %s 2>/dev/null | tail -n +2" % (MOUNT, "/home/daytona"))
        ledger.step("environment", output=env["output"][-600:], exit=env["exit"])
        for label, root in (("volume", vroot), ("local", lroot)):
            res = provider.exec_json(sid, "python3 %s --matrix write --root %s --big-mib %d" % (REMOTE_SCRIPT, root, plan["bigFileMiB"]))
            ledger.step("matrixWrite", target=label, result=res)

        provider.sandbox_stop(sid)
        stopped_volume = provider.volume_get(vol["id"])
        ledger.step("stoppedObservation", sandboxState=provider.sandbox_state(sid),
                    volumeState=(stopped_volume or {}).get("state"),
                    volumeContentApi="none: volume API has create/get/list/delete only; content needs a mounting sandbox")
        provider.sandbox_start(sid)
        verify = {}
        for label, root in (("volume", vroot), ("local", lroot)):
            verify[label] = provider.exec_json(sid, "python3 %s --matrix verify --root %s" % (REMOTE_SCRIPT, root))
            ledger.step("matrixVerifyAfterRestart", target=label, result=verify[label])
        ledger.data["proof"] = {"verified": all(v.get("ok") for v in verify.values()),
                                "volumeRestartMatch": verify["volume"].get("ok"),
                                "localRestartMatch": verify["local"].get("ok"),
                                "kind": "live"}
        ledger.data["result"] = "completed"
    except Refused as exc:
        ledger.data["result"] = "account-or-plan-refused"
        ledger.data["refusal"] = str(exc)[:300]
        ledger.data["proof"] = {"verified": False, "aborted": True, "kind": "live"}
    except Unknown as exc:
        ledger.data["result"] = "unknown-create"
        ledger.data["unknown"] = str(exc)
        ledger.data["proof"] = {"verified": False, "kind": "live"}
    except Exception as exc:
        ledger.data["result"] = "failed"
        ledger.data["failure"] = redact(exc)
        ledger.data["proof"] = {"verified": False, "aborted": True, "kind": "live"}
    ledger.data["unmeasured"] = {
        "separateMachineReconnect": "budget allows one sandbox; not measured",
        "snapshotBoundary": "needs a snapshot plus a second sandbox to inspect; not created",
        "providerCommitAck": "no API; only fsync return and post-restart re-read observed",
        "concurrentWriters": "docs: last write wins; not measured with one machine"}
    ledger.save()
    if ledger.data["result"] != "unknown-create":
        cleanup(ledger, provider)
    return ledger.data


class DaytonaProvider:
    """Thin SDK wrapper; the API key is read from the environment and never echoed."""
    delete_wait = 120

    def __init__(self):
        from daytona import Daytona, DaytonaConfig
        key = os.environ.get("DAYTONA_API_KEY")
        if not key:
            raise Refused("DAYTONA_API_KEY is not set")
        self.client = Daytona(DaytonaConfig(api_key=key, api_url=os.environ.get("DAYTONA_API_URL") or None))
        self._sandboxes = {}

    sleep = staticmethod(time.sleep)

    @staticmethod
    def _vol(v):
        return {"id": v.id, "name": v.name, "state": str(getattr(v.state, "value", v.state))}

    def volume_list(self):
        return [self._vol(v) for v in self.client.volume.list()]

    def volume_find(self, name):
        return next((v for v in self.volume_list() if v["name"] == name), None)

    def volume_create(self, name):
        v = self.client.volume.create(name)
        return {"id": v.id, "detail": self._vol(v)}

    def volume_get(self, vid):
        return next((v for v in self.volume_list() if v["id"] == vid), None)

    def wait_volume_ready(self, vid, timeout=180):
        deadline = time.time() + timeout
        while True:
            v = self.volume_get(vid)
            state = v and v["state"]
            if state in ("ready", "error") or time.time() > deadline:
                return state
            time.sleep(3)

    def volume_delete(self, vid):
        v = next(v for v in self.client.volume.list() if v.id == vid)
        self.client.volume.delete(v)

    def sandbox_create(self, spec):
        from daytona import CreateSandboxFromSnapshotParams, VolumeMount
        params = CreateSandboxFromSnapshotParams(
            name=spec["name"], labels=spec["labels"], auto_stop_interval=spec["autoStopMinutes"],
            auto_delete_interval=spec["autoDeleteMinutes"], ttl_minutes=spec["ttlMinutes"], ephemeral=False,
            volumes=[VolumeMount(volume_id=m["volumeId"], mount_path=m["mountPath"]) for m in spec["volumes"]])
        sb = self.client.create(params, timeout=180)
        self._sandboxes[sb.id] = sb
        return {"id": sb.id, "detail": {"target": getattr(sb, "target", None), "cpu": getattr(sb, "cpu", None),
                                        "memory": getattr(sb, "memory", None), "disk": getattr(sb, "disk", None),
                                        "snapshot": getattr(sb, "snapshot", None)}}

    def _sb(self, sid):
        sb = self._sandboxes.get(sid) or self.client.get(sid)
        self._sandboxes[sid] = sb
        return sb

    def sandbox_find(self, run_id, name):
        from daytona import ListSandboxesQuery
        hits = [s for s in self.client.list(ListSandboxesQuery(labels={"cbfs-probe-run": run_id})) if s.name == name]
        return {"id": hits[0].id, "name": hits[0].name, "labels": dict(hits[0].labels or {})} if len(hits) == 1 else None

    def sandbox_get(self, sid):
        try:
            sb = self.client.get(sid)
        except Exception as exc:
            if getattr(exc, "status_code", None) == 404:
                return None
            raise
        if str(getattr(sb.state, "value", sb.state)) in ("destroyed", "destroying"):
            return None
        return {"id": sb.id, "name": sb.name, "labels": dict(sb.labels or {})}

    def sandbox_state(self, sid):
        sb = self._sb(sid)
        sb.refresh_data()
        return str(getattr(sb.state, "value", sb.state))

    def sandbox_stop(self, sid):
        self._sb(sid).stop(timeout=180)

    def sandbox_start(self, sid):
        self._sb(sid).start(timeout=180)

    def sandbox_delete(self, sid):
        self._sb(sid).delete()

    def upload(self, sid, data, path):
        self._sb(sid).fs.upload_file(data, path)

    def exec(self, sid, cmd, timeout=300):
        r = self._sb(sid).process.exec(cmd, timeout=timeout)
        return {"exit": r.exit_code, "output": r.result or ""}

    def exec_json(self, sid, cmd):
        r = self.exec(sid, cmd)
        try:
            return json.loads(r["output"].strip().splitlines()[-1])
        except (ValueError, IndexError):
            return {"ok": False, "exit": r["exit"], "rawTail": r["output"][-400:]}


def dry_run(plan):
    data = check_plan(plan)
    return {"mode": "dry-run", "network": False, "credentialPresent": bool(os.environ.get("DAYTONA_API_KEY")),
            "account": "env:DAYTONA_API_KEY (no fallback account)", "limits": LIMITS, "plan": plan,
            "syntheticBytes": data,
            "creates": [{"kind": "volume", "name": PREFIX + "<runId>", "ledgerIntentFirst": True},
                        {"kind": "sandbox", "name": PREFIX + "<runId>", "labels": {"cbfs-probe-run": "<runId>", "owner": OWNER_LABEL},
                         "mount": MOUNT, "ttlMinutes": plan["ttlMinutes"], "gpu": 0}],
            "steps": ["preflight volume list (metadata)", "create volume", "wait ready", "create sandbox", "matrix write volume+local",
                      "stop", "observe volume while stopped", "start", "verify after restart", "cleanup owned only"],
            "neverTouches": "any sandbox/volume whose id+name(+labels) is not recorded in this run's ledger"}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="print the plan; no network, no credentials used")
    mode.add_argument("--live", action="store_true", help="run the bounded live probe (creates 1 volume + 1 CPU sandbox)")
    mode.add_argument("--reconcile", action="store_true", help="look up unknown creates recorded in the ledger")
    mode.add_argument("--cleanup", action="store_true", help="delete only resources this ledger proves it created")
    mode.add_argument("--matrix", choices=("write", "verify"), help="run the file matrix on --root (inside the machine)")
    ap.add_argument("--ledger", help="ledger JSON path (required for --live/--reconcile/--cleanup)")
    ap.add_argument("--run-id", help="fixed run id for a new ledger")
    ap.add_argument("--root", help="matrix root directory")
    ap.add_argument("--big-mib", type=int, default=DEFAULT_PLAN["bigFileMiB"])
    ap.add_argument("--force-volume-cleanup", action="store_true", help="with --cleanup: delete the owned volume even without proof")
    a = ap.parse_args(argv)
    plan = dict(DEFAULT_PLAN, bigFileMiB=a.big_mib)
    if a.matrix:
        if not a.root:
            ap.error("--matrix needs --root")
        print(json.dumps(matrix_write(a.root, a.big_mib) if a.matrix == "write" else matrix_verify(a.root)))
        return 0
    if a.dry_run:
        print(json.dumps(dry_run(plan), indent=2))
        return 0
    if not a.ledger:
        ap.error("--ledger is required")
    ledger = Ledger.open(a.ledger, a.run_id)
    if a.live:
        if ledger.data.get("result"):
            ap.error("ledger already holds a finished run; use a new ledger")
        with open(os.path.abspath(__file__), encoding="utf8") as f:
            source = f.read()
        out = run_live(ledger, DaytonaProvider(), plan, source)
        print(json.dumps({k: out.get(k) for k in ("runId", "result", "proof")}, indent=2))
        return 0 if out["result"] == "completed" else 2
    provider = DaytonaProvider()
    if a.reconcile:
        out = {}
        for rec in ledger.data["resources"]:
            if rec["state"] in ("intent", "unknown") and not rec.get("id"):
                found = provider.volume_find(rec["name"]) if rec["kind"] == "volume" else provider.sandbox_find(ledger.data["runId"], rec["name"])
                if found:
                    rec.update(id=found["id"], state="created", reconciled=True)
                out[rec["kind"]] = rec["state"]
        ledger.step("reconcile", outcome=out)
        print(json.dumps(out))
        return 0
    print(json.dumps(cleanup(ledger, provider, only_after_proof=not a.force_volume_cleanup)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
