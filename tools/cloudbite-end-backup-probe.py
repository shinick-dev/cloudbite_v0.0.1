#!/usr/bin/env python3
"""Bounded live probe of the CloudBite end backup: a cold filesystem capture of a STOPPED owned machine
through the ACTUAL src/cloudbite-computer-backups.ts manager, then a restore onto a new machine.

    python tools/cloudbite-end-backup-probe.py                       (dry run: plan only, no network)
    python tools/cloudbite-end-backup-probe.py --live --out DIR      (creates <=2 sandboxes sequentially, 1 snapshot)
    python tools/cloudbite-end-backup-probe.py --cleanup --ledger FILE
    python tools/cloudbite-end-backup-probe.py --gen write|verify --root DIR   (runs inside the machine)

--live: verify the public base snapshot's metadata, create one synthetic source machine (1 CPU / 1 GiB / 3 GiB, no GPU),
write deterministic synthetic files (<=32 MiB, Unicode names, modes, fsync), stop it, then run the compiled manager's
begin()/tick() with a private file-backed store and a real Daytona REST provider (tools/cloudbite-end-backup-probe.mjs).
Once the manager reports the capture active AND an independent read proves exact name + id + sourceSandboxId == source +
general == false, the source is deleted (absence verified), a restore machine is created from that exact snapshot, and
every file's size/SHA-256/mode is compared. Finally the restore is deleted and the one test snapshot is deleted by id after
a fresh ownership proof, polled until 404. Intent is written to the ledger before every create/delete; an unknown create is
reconciled by exact name + labels and never re-sent. Only resources recorded in the ledger are ever addressed.
The key is read from DAYTONA_API_KEY only and never written to argv, files or output.

Budget (monotonic clock): the phase limit minus the cleanup reserve bounds all work, and cumulative machine active time
(wall-clock from create intent, so startup and an unknown create count, until confirmed stopped/absent) is capped by
activeCpuSeconds minus a stop reserve. Every create, upload, command, manager call and capture wait is checked first and
its SDK/subprocess timeout is clamped to what remains; provider auto-stop/TTL/auto-delete are derived from the remainder.
An exhausted budget stops new work and new resources; cleanup of ledger-proven resources still runs. Active time is a
started-to-stopped measurement, not provider-billed CPU usage.
"""
import argparse
import hashlib
import json
import os
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

API = "https://app.daytona.io/api"
BASE_SNAPSHOT = "daytonaio/sandbox:0.8.0"          # public base named by the prior probe's sandbox detail
BASE_EXPECT = {"general": True, "state": "active", "cpu": 1, "mem": 1, "disk": 3}
PROTECTED_SANDBOXES = {"1af294ee-b648-461c-a78a-039695413922"}   # the user's personal VM: never addressed
PREFIX = "cbbak-probe-"
OWNER_LABEL = "cloudbite-end-backup-probe"
ACCOUNT = "probe"
ROOT = "/home/daytona/cbbak"
REMOTE_SCRIPT = "/tmp/cbbak_probe.py"
CAPS = {"cpu": 1, "memory": 1, "disk": 3, "gpu": 0}
LIMITS = {"maxSandboxes": 2, "maxSnapshots": 1, "maxSyntheticBytes": 32 * 1024 * 1024, "phaseSeconds": 30 * 60,
          "activeCpuSeconds": 15 * 60, "tickSeconds": 10, "cleanupReserveSeconds": 6 * 60,
          "stopReserveSeconds": 90, "minStepSeconds": 30, "restoreNeedSeconds": 240, "autoStopMaxMinutes": 5}
TIMEOUTS = {"create": 180, "upload": 120, "exec": 300, "stop": 60, "node": 240}
HERE = os.path.dirname(os.path.abspath(__file__))
NODE_DRIVER = os.path.join(HERE, "cloudbite-end-backup-probe.mjs")


# ---------------------------------------------------------------- synthetic files (stdlib only; runs in the machine)

def _stream(seed, size):
    out, counter = bytearray(), 0
    while len(out) < size:
        out += hashlib.sha256(("%s:%d" % (seed, counter)).encode()).digest() * 64
        counter += 1
    return bytes(out[:size])


def synthetic_spec():
    """(kind, rel, mode, payload) in creation order. Deterministic; payload is bytes for files, target for links."""
    settings = json.dumps({"probe": "cloudbite-end-backup", "theme": "dark", "lang": "ko", "v": 1}, sort_keys=True).encode()
    return [
        ("dir", ".config", 0o700, None),
        ("dir", ".config/cloudbite-probe", 0o700, None),
        ("file", ".config/cloudbite-probe/settings.json", 0o600, settings),
        ("file", ".config/cloudbite-probe/env.toml", 0o644, b'[probe]\nregion = "us"\nretries = 3\n'),
        ("dir", "bin", 0o755, None),
        ("file", "bin/run-probe.sh", 0o755, b"#!/bin/sh\necho cloudbite end backup probe\n"),
        ("dir", "한글 폴더", 0o755, None),
        ("file", "한글 폴더/파일 ✓ é.txt", 0o644, "한글 내용 ✓ é\n".encode()),
        ("dir", "日本語", 0o750, None),
        ("file", "日本語/データ.bin", 0o640, _stream("cbbak-jp", 64 * 1024)),
        ("dir", "emoji 🙂", 0o755, None),
        ("file", "emoji 🙂/name with spaces.txt", 0o644, b"spaces and emoji\n"),
        ("dir", "data", 0o755, None),
        ("file", "data/big.bin", 0o644, _stream("cbbak-big", 24 * 1024 * 1024)),
        ("file", "data/medium.bin", 0o600, _stream("cbbak-medium", 4 * 1024 * 1024)),
        ("file", "data/empty.txt", 0o644, b""),
        ("dir", "empty", 0o755, None),
        ("link", "link-to-settings", None, ".config/cloudbite-probe/settings.json"),
    ]


def expected_manifest():
    files, dirs, links = {}, {}, {}
    for kind, rel, mode, payload in synthetic_spec():
        if kind == "file":
            files[rel] = {"size": len(payload), "sha256": hashlib.sha256(payload).hexdigest(), "mode": oct(mode)}
        elif kind == "dir":
            dirs[rel] = {"mode": oct(mode)}
        else:
            links[rel] = {"target": payload}
    return {"files": files, "dirs": dirs, "links": links, "bytes": sum(f["size"] for f in files.values())}


def _sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def walk(root):
    files, dirs, links = {}, {}, {}
    for cur, dnames, fnames in os.walk(root, followlinks=False):
        for n in dnames + fnames:
            p = os.path.join(cur, n)
            rel = os.path.relpath(p, root).replace(os.sep, "/")
            st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode):
                links[rel] = {"target": os.readlink(p)}
            elif stat.S_ISDIR(st.st_mode):
                dirs[rel] = {"mode": oct(stat.S_IMODE(st.st_mode))}
            else:
                files[rel] = {"size": st.st_size, "sha256": _sha(p), "mode": oct(stat.S_IMODE(st.st_mode))}
    return {"files": files, "dirs": dirs, "links": links, "bytes": sum(f["size"] for f in files.values())}


def compare(want, got, modes=True):
    bad = []
    for group in ("files", "dirs", "links"):
        for rel in sorted(set(want[group]) | set(got[group])):
            w, g = want[group].get(rel), got[group].get(rel)
            if w is None or g is None:
                bad.append({"kind": group, "rel": rel, "issue": "missing" if g is None else "extra"})
                continue
            for k in w:
                if k == "mode" and not modes:
                    continue
                if w[k] != g.get(k):
                    bad.append({"kind": group, "rel": rel, "issue": k})
    return bad


def gen_write(root):
    os.makedirs(root, exist_ok=True)
    t = time.perf_counter()
    os.umask(0)
    for kind, rel, mode, payload in synthetic_spec():
        p = os.path.join(root, *rel.split("/"))
        if kind == "dir":
            os.makedirs(p, exist_ok=True)
            os.chmod(p, mode)
        elif kind == "file":
            with open(p, "wb") as f:
                f.write(payload)
                f.flush()
                os.fsync(f.fileno())
            os.chmod(p, mode)
        else:
            if os.path.lexists(p):
                os.remove(p)
            os.symlink(payload, p)
    for cur, _d, _f in os.walk(root):
        fd = os.open(cur, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    os.sync()
    got = walk(root)
    return {"mode": "write", "ms": round((time.perf_counter() - t) * 1000, 1), "manifest": got,
            "mismatches": compare(expected_manifest(), got)}


def gen_verify(root):
    t = time.perf_counter()
    got = walk(root) if os.path.isdir(root) else {"files": {}, "dirs": {}, "links": {}, "bytes": 0}
    bad = compare(expected_manifest(), got)
    return {"mode": "verify", "ms": round((time.perf_counter() - t) * 1000, 1), "manifest": got, "mismatches": bad,
            "ok": not bad}


# ---------------------------------------------------------------- REST (stdlib, no redirects, sanitized errors)

class ApiError(Exception):
    def __init__(self, status, op, reason=""):
        super().__init__("daytona %s %s%s" % (op, "HTTP %d" % status if status else "unanswered", ": " + reason if reason else ""))
        self.status, self.op, self.reason = status, op, reason


class Refused(Exception):
    """A plan, cap, ownership or provider refusal; recorded, never retried with a larger machine."""


class Unknown(Exception):
    """An outcome is unknown: reconcile by exact lookup, never re-send."""


class BudgetExhausted(Refused):
    """The phase or active-machine budget cannot cover the next step: no new work or resource; cleanup still runs."""


class Budget:
    """Monotonic phase budget plus cumulative machine active time. A machine's active interval opens at create intent
    (startup and an unknown create count) and closes only when it is confirmed stopped or absent; an interval left open
    keeps growing with the clock. This is a started-to-stopped wall-clock measurement, not provider-billed CPU usage."""

    def __init__(self, clock=time.monotonic, limits=LIMITS):
        self.clock, self.limits = clock, limits
        self.t0 = clock()
        self.active = {}

    def elapsed(self):
        return self.clock() - self.t0

    def open(self, role):
        if role not in self.active:
            self.active[role] = [self.clock(), None]

    def close(self, role):
        if role in self.active and self.active[role][1] is None:
            self.active[role][1] = self.clock()

    def open_roles(self):
        return sorted(r for r, (_s, e) in self.active.items() if e is None)

    def active_used(self):
        now = self.clock()
        return sum((e if e is not None else now) - s for s, e in self.active.values())

    def work_left(self):
        return self.limits["phaseSeconds"] - self.limits["cleanupReserveSeconds"] - self.elapsed()

    def active_left(self):
        return self.limits["activeCpuSeconds"] - self.limits["stopReserveSeconds"] - self.active_used()

    def timeout(self, step, cap, active=False, need=None):
        """Seconds the next step may take (an int >= minStepSeconds, never 0 = 'no timeout'), or BudgetExhausted."""
        left = min(self.work_left(), self.active_left()) if active else self.work_left()
        if left < max(self.limits["minStepSeconds"], need or 0):
            raise BudgetExhausted("%s: budget exhausted (work %ds, active %ds left)"
                                  % (step, max(0, self.work_left()), max(0, self.active_left())))
        return int(min(cap, left))

    def stop_timeout(self, cap):
        """Stop/cleanup is never refused for budget; it is kept inside the phase when the phase still allows it."""
        return int(max(10, min(cap, self.limits["phaseSeconds"] - self.elapsed())))

    def before_create(self, role, need=None):
        """(create timeout, provider auto-stop minutes, TTL minutes) for a new machine, or BudgetExhausted."""
        if self.open_roles():
            raise BudgetExhausted("create %s: active time of %s is still open; budget uncertain" % (role, self.open_roles()))
        t = self.timeout("create " + role, TIMEOUTS["create"], active=True, need=need)
        auto_stop = min(self.limits["autoStopMaxMinutes"], int(self.active_left() // 60))
        ttl = int((self.limits["phaseSeconds"] - self.elapsed()) // 60)
        if auto_stop < 1 or ttl < 1:
            raise BudgetExhausted("create %s: no room for provider auto-stop/TTL" % role)
        return t, auto_stop, ttl

    def report(self):
        now = self.clock()
        return {"measure": "wall-clock from create intent to confirmed stopped/absent; not provider-billed CPU usage",
                "elapsed": round(now - self.t0, 1), "activeUsed": round(self.active_used(), 1),
                "machines": {r: {"seconds": round((e if e is not None else now) - s, 1), "closed": e is not None}
                             for r, (s, e) in self.active.items()}}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def sanitize(text):
    s = str(text or "")
    key = os.environ.get("DAYTONA_API_KEY")
    if key:
        s = s.replace(key, "<redacted>")
    return " ".join(s.split())[:160]


class Rest:
    def __init__(self, ops_log):
        self.key = os.environ.get("DAYTONA_API_KEY")
        if not self.key:
            raise Refused("DAYTONA_API_KEY is not set")
        self.opener = urllib.request.build_opener(_NoRedirect)
        self.ops_log = ops_log

    def _log(self, rec):
        with open(self.ops_log, "a", encoding="utf8") as f:
            f.write(json.dumps(dict(at=_now(), **rec), ensure_ascii=False) + "\n")

    def call(self, op, method, path, body=None, absent_ok=False):
        req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Authorization": "Bearer " + self.key, "Accept": "application/json",
                                              **({"Content-Type": "application/json"} if body is not None else {})})
        t = time.perf_counter()
        try:
            with self.opener.open(req, timeout=30) as r:
                status, text = r.status, r.read().decode("utf8", "replace")
        except urllib.error.HTTPError as e:
            status = e.code
            try:
                text = e.read().decode("utf8", "replace")
            except Exception:
                text = ""
        except Exception as e:
            self._log({"op": op, "method": method, "status": 0, "ms": _ms(t), "error": type(e).__name__})
            raise ApiError(0, op)
        ms = _ms(t)
        try:
            data = json.loads(text) if text else None
        except ValueError:
            data = None
        if status == 404 and absent_ok:
            self._log({"op": op, "method": method, "status": 404, "ms": ms})
            return None
        if status >= 300:
            reason = sanitize((data or {}).get("message") if isinstance(data, dict) else "")
            self._log({"op": op, "method": method, "status": status, "ms": ms, "reason": reason})
            raise ApiError(status, op, reason)
        self._log({"op": op, "method": method, "status": status, "ms": ms, "view": _view(data)})
        return data

    def snapshot(self, name_or_id):
        return self.call("snapshot-get", "GET", "/snapshots/" + urllib.parse.quote(name_or_id, safe=""), absent_ok=True)

    def sandbox(self, id_or_name):
        _guard_protected(id_or_name)
        return self.call("sandbox-get", "GET", "/sandbox/" + urllib.parse.quote(id_or_name, safe=""), absent_ok=True)

    def delete_snapshot(self, sid):
        return self.call("snapshot-delete", "DELETE", "/snapshots/" + urllib.parse.quote(sid, safe=""), absent_ok=True)


def _view(d):
    if not isinstance(d, dict):
        return None
    keys = ("id", "name", "state", "general", "sourceSandboxId", "cpu", "mem", "memory", "disk", "gpu", "labels", "snapshot")
    return {k: d.get(k) for k in keys if k in d}


def _ms(t):
    return round((time.perf_counter() - t) * 1000)


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _guard_protected(sid):
    if sid in PROTECTED_SANDBOXES:
        raise Refused("refusing to address a protected sandbox")


# ---------------------------------------------------------------- ownership proofs

def base_ok(info):
    if not isinstance(info, dict) or info.get("name") != BASE_SNAPSHOT:
        return False
    return all(info.get(k) == v for k, v in BASE_EXPECT.items()) and not info.get("gpu")


def sandbox_owned(info, rec):
    """Exact id + name + run/owner/role labels, as recorded in the ledger."""
    if not isinstance(info, dict) or not rec.get("id"):
        return False
    labels = info.get("labels") or {}
    return (info.get("id") == rec["id"] and info.get("name") == rec["name"]
            and all(labels.get(k) == v for k, v in rec["labels"].items()))


def caps_ok(info):
    return (isinstance(info, dict) and isinstance(info.get("cpu"), (int, float)) and info["cpu"] <= CAPS["cpu"]
            and isinstance(info.get("memory"), (int, float)) and info["memory"] <= CAPS["memory"]
            and isinstance(info.get("disk"), (int, float)) and info["disk"] <= CAPS["disk"] and not info.get("gpu"))


def snapshot_owned(info, name, source_id, sid=None):
    """Exact generated name (+ id when known) + sourceSandboxId == owned source + general is False."""
    return (isinstance(info, dict) and info.get("name") == name and isinstance(info.get("id"), str) and bool(info["id"])
            and (sid is None or info["id"] == sid) and info.get("sourceSandboxId") == source_id and info.get("general") is False)


# ---------------------------------------------------------------- ledger

class Ledger:
    def __init__(self, path, data):
        self.path, self.data = path, data

    @classmethod
    def new(cls, path, run_id):
        return cls(path, {"schema": "cloudbite.end-backup-probe.v2", "runId": run_id, "account": "env:DAYTONA_API_KEY",
                          "limits": LIMITS, "timeouts": TIMEOUTS, "caps": CAPS, "base": BASE_SNAPSHOT, "createdAt": _now(),
                          "probe": {"py": _sha(os.path.abspath(__file__)), "mjs": _sha(NODE_DRIVER)},
                          "resources": [], "steps": [], "timings": {}, "result": None})

    @classmethod
    def open(cls, path):
        with open(path, encoding="utf8") as f:
            return cls(path, json.load(f))

    def save(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf8") as f:
            json.dump(self.data, f, indent=2, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)

    def step(self, name, **fields):
        self.data["steps"].append(dict(step=name, at=_now(), **fields))
        self.save()

    def res(self, role):
        return next((r for r in self.data["resources"] if r["role"] == role), None)


class Phase:
    def __init__(self, ledger, name):
        self.ledger, self.name = ledger, name

    def __enter__(self):
        self.t = time.perf_counter()

    def __exit__(self, *exc):
        self.ledger.data["timings"][self.name] = round(time.perf_counter() - self.t, 2)
        self.ledger.save()


# ---------------------------------------------------------------- sandbox lifecycle (SDK) with ledger intent

class Machines:
    def __init__(self, ledger, rest, budget=None, client=None, params=None, sleep=time.sleep):
        if client is None:
            from daytona import Daytona, DaytonaConfig
            client = Daytona(DaytonaConfig(api_key=os.environ["DAYTONA_API_KEY"], target="us", otel_enabled=False))
        self.client, self.params, self.sleep = client, params, sleep
        self.ledger, self.rest, self.objs = ledger, rest, {}
        self.budget = budget or Budget()

    def create(self, role, snapshot, need=None):
        L = self.ledger
        if sum(1 for r in L.data["resources"] if r["kind"] == "sandbox") >= LIMITS["maxSandboxes"]:
            raise Refused("sandbox budget exhausted")
        if any(r["state"] in ("intent", "unknown", "delete-unknown") for r in L.data["resources"]):
            raise Refused("an earlier outcome is unknown; no new test resource")
        timeout, auto_stop, ttl = self.budget.before_create(role, need)
        if self.params is None:
            from daytona import CreateSandboxFromSnapshotParams
            self.params = CreateSandboxFromSnapshotParams
        run = L.data["runId"]
        rec = {"kind": "sandbox", "role": role, "name": "%s%s-%s" % (PREFIX, run, role[:3]),
               "labels": {"owner": OWNER_LABEL, "cbbak-probe-run": run, "cbbak-role": role},
               "snapshot": snapshot, "state": "intent", "intentAt": _now(), "id": None,
               "provider": {"autoStopMinutes": auto_stop, "autoDeleteMinutes": ttl, "ttlMinutes": ttl, "timeout": timeout}}
        if self.rest.sandbox(rec["name"]) is not None:
            raise Refused("a sandbox named %s already exists outside this ledger" % rec["name"])
        L.data["resources"].append(rec)
        L.save()
        # TTL counts from creation, so the provider destroys the machine by the phase end even if this process dies;
        # auto-delete-after-stop is no longer than TTL; idle auto-stop fits the remaining active budget
        params = self.params(snapshot=snapshot, name=rec["name"], labels=rec["labels"], auto_stop_interval=auto_stop,
                             auto_delete_interval=ttl, ttl_minutes=ttl, ephemeral=False)
        self.budget.open(role)
        try:
            sb = self.client.create(params, timeout=timeout)
            rec.update(id=sb.id, state="created", createdAt=_now())
            self.objs[sb.id] = sb
        except Exception as exc:
            status = getattr(exc, "status_code", None)
            rec["error"] = {"type": type(exc).__name__, "status": status, "message": sanitize(exc)}
            rec["state"] = "unknown"
            L.save()
            found = self.rest.sandbox(rec["name"])      # reconcile by exact name + labels; never re-send
            labels = (found or {}).get("labels") or {}
            if found and all(labels.get(k) == v for k, v in rec["labels"].items()):
                rec.update(id=found["id"], state="created", reconciled=True)
            elif found is None and isinstance(status, int) and 400 <= status < 500 and status not in (408, 429):
                rec["state"] = "refused"
                self.budget.close(role)
                L.save()
                raise Refused("sandbox create refused: HTTP %s %s" % (status, rec["error"]["message"][:100]))
            else:
                L.save()
                raise Unknown("sandbox create outcome unknown; recorded, not re-sent")
        L.save()
        info = self.rest.sandbox(rec["id"])
        if not sandbox_owned(info, rec):
            raise Refused("created sandbox does not prove ownership")
        rec["detail"] = {k: info.get(k) for k in ("cpu", "memory", "disk", "gpu", "target", "snapshot", "state")}
        L.save()
        if not caps_ok(info):
            raise Refused("machine resources exceed caps: %s" % rec["detail"])
        return rec

    def sb(self, rec):
        _guard_protected(rec["id"])
        if rec["id"] not in self.objs:
            self.objs[rec["id"]] = self.client.get(rec["id"])
        return self.objs[rec["id"]]

    def upload(self, rec, data, path):
        self.sb(rec).fs.upload_file(data, path, timeout=self.budget.timeout("upload " + rec["role"], TIMEOUTS["upload"], True))

    def exec_json(self, rec, cmd):
        r = self.sb(rec).process.exec(cmd, timeout=self.budget.timeout("exec " + rec["role"], TIMEOUTS["exec"], True))
        try:
            return json.loads((r.result or "").strip().splitlines()[-1])
        except (ValueError, IndexError):
            return {"ok": False, "exit": r.exit_code, "unparsed": True}

    def stop(self, rec):
        self.sb(rec).stop(timeout=self.budget.stop_timeout(TIMEOUTS["stop"]))
        info = self.rest.sandbox(rec["id"])
        state = (info or {}).get("state")
        rec["stoppedState"] = state
        if state == "stopped":
            self.budget.close(rec["role"])
        self.ledger.save()
        return state

    def delete(self, rec):
        """Ledger-owned only; intent first; absence (404 or destroyed) verified by REST."""
        if rec.get("state") == "deleted" or not rec.get("id"):
            return rec.get("state")
        info = self.rest.sandbox(rec["id"])
        if info is None or info.get("state") == "destroyed":
            rec.update(state="deleted", deletedAt=_now(), absence="already-absent")
            self.budget.close(rec["role"])
            self.ledger.save()
            return "deleted"
        if not sandbox_owned(info, rec):
            rec["deleteRefused"] = "ownership not proven"
            self.ledger.save()
            return "refused-not-owned"
        rec.update(state="deleting", deleteIntentAt=_now())
        self.ledger.save()
        try:
            self.client.delete(self.sb(rec), timeout=self.budget.stop_timeout(120), wait=True)
        except Exception as exc:
            rec["deleteError"] = {"type": type(exc).__name__, "status": getattr(exc, "status_code", None), "message": sanitize(exc)}
        for _ in range(24):
            info = self.rest.sandbox(rec["id"])
            if info is None or info.get("state") == "destroyed":
                rec.update(state="deleted", deletedAt=_now(), absence="404" if info is None else "destroyed")
                self.budget.close(rec["role"])
                self.ledger.save()
                return "deleted"
            self.sleep(5)
        rec["state"] = "delete-unknown"
        self.ledger.save()
        return "delete-unknown"


# ---------------------------------------------------------------- manager (compiled actual source, via Node)

class Manager:
    runner = staticmethod(subprocess.run)

    def __init__(self, ledger, outdir, source_id, budget):
        self.ledger, self.outdir, self.source_id, self.budget = ledger, outdir, source_id, budget
        run = ledger.data["runId"]
        self.owner = "probe" + run
        self.store = os.path.join(outdir, "manager-store-%s.json" % run)
        self.ops = os.path.join(outdir, "provider-ops-%s.jsonl" % run)
        self.module = None

    def _node(self, *argv):
        step = "manager " + (argv[argv.index("--op") + 1] if "--op" in argv else argv[0])
        timeout = self.budget.timeout(step, TIMEOUTS["node"])
        r = self.runner(["node", NODE_DRIVER, *argv], capture_output=True, text=True, encoding="utf8", timeout=timeout)
        line = (r.stdout or "").strip().splitlines()
        out = json.loads(line[-1]) if line else {"error": "no output", "exit": r.returncode}
        if r.returncode != 0 or (isinstance(out, dict) and out.get("error")):
            raise RuntimeError("manager driver failed: %s" % sanitize(out))
        return out

    def build(self):
        out = self._node("build", "--out", self.outdir)
        self.module = out["module"]
        return out

    def run(self, op, request=None):
        argv = ["run", "--module", self.module, "--store", self.store, "--ops", self.ops, "--owner", self.owner,
                "--op", op, "--source", self.source_id, "--protect", BASE_SNAPSHOT]
        if request is not None:
            req = os.path.join(self.outdir, "begin-request-%s.json" % self.ledger.data["runId"])
            with open(req, "w", encoding="utf8") as f:
                json.dump(request, f)
            argv += ["--request", req]
        return self._node(*argv)

    def item(self):
        with open(self.store, encoding="utf8") as f:
            led = json.load(f)["computer-backups:v1:" + self.owner]
        return (led["items"] or [None])[0], led


# ---------------------------------------------------------------- live run

def snapshot_cleanup(ledger, rest, sleep=time.sleep):
    """Delete only the ledger's one test snapshot, after a fresh exact ownership proof by id; poll until 404."""
    rec = ledger.res("snapshot")
    src = ledger.res("source")
    if not rec or rec.get("state") in ("deleted", "absent"):
        return rec and rec.get("state")
    if not rec.get("id"):
        info = rest.snapshot(rec["name"])        # exact generated name only
        if info is None:
            # A create whose answer never came may still land: 404 now is recorded, not treated as proof of absence.
            # Only a never-sent intent or a definite provider refusal makes 404 conclusive.
            sent = rec.get("state") not in ("manager-intent", "manager-refused", "manager-skipped")
            rec.update(state="absent-unconfirmed" if sent else "absent", checkedAt=_now(),
                       note="404 by exact name; no id ever proven")
            ledger.save()
            return rec["state"]
        if not snapshot_owned(info, rec["name"], src and src.get("id")):
            rec.update(state="retained-unproven", checkedAt=_now())
            ledger.save()
            return "retained-unproven"
        rec["id"] = info["id"]
    info = rest.snapshot(rec["id"])
    if info is None:
        rec.update(state="deleted", deletedAt=_now(), absence="404")
        ledger.save()
        return "deleted"
    if info.get("name") == BASE_SNAPSHOT or not snapshot_owned(info, rec["name"], src and src.get("id"), rec["id"]):
        rec.update(state="retained-unproven", checkedAt=_now())
        ledger.save()
        return "retained-unproven"
    rec.update(state="deleting", deleteIntentAt=_now(), proofBeforeDelete=_view(info))
    ledger.save()
    try:
        rest.delete_snapshot(rec["id"])
    except ApiError as exc:
        rec["deleteError"] = {"status": exc.status, "reason": exc.reason}
        ledger.save()
    for _ in range(36):
        info = rest.snapshot(rec["id"])
        if info is None:
            rec.update(state="deleted", deletedAt=_now(), absence="404")
            ledger.save()
            return "deleted"
        rec["lastState"] = info.get("state")
        sleep(5)
    rec["state"] = "delete-unknown"
    ledger.save()
    return "delete-unknown"


def run_live(ledger, outdir, budget=None, rest=None, make_machines=None, make_manager=None, sleep=time.sleep):
    """make_machines(ledger, rest, budget) / make_manager(ledger, outdir, source_id, budget) default to the real SDK and
    Node driver; the offline suite passes fakes with a fake clock."""
    budget = budget or Budget()
    t0 = budget.clock()
    rest = rest or Rest(os.path.join(outdir, "rest-ops-%s.jsonl" % ledger.data["runId"]))
    make_machines = make_machines or (lambda L, r, b: Machines(L, r, b, sleep=sleep))
    make_manager = make_manager or Manager
    want = expected_manifest()
    if want["bytes"] > LIMITS["maxSyntheticBytes"]:
        raise Refused("synthetic data exceeds the cap")
    ledger.data["expected"] = {"bytes": want["bytes"], "files": len(want["files"]), "dirs": len(want["dirs"]),
                               "links": len(want["links"])}
    machines = mgr = None
    try:
        with Phase(ledger, "preflight"):
            base = rest.snapshot(BASE_SNAPSHOT)
            ledger.step("baseSnapshot", view=_view(base), ok=base_ok(base))
            if not base_ok(base):
                raise Refused("public base snapshot metadata differs from the verified values")
            ledger.data["baseId"] = base["id"]
            machines = make_machines(ledger, rest, budget)

        with Phase(ledger, "sourceCreate"):
            src = machines.create("source", BASE_SNAPSHOT)
        with Phase(ledger, "sourceWrite"):
            with open(os.path.abspath(__file__), encoding="utf8") as f:
                machines.upload(src, f.read().encode("utf8"), REMOTE_SCRIPT)
            wrote = machines.exec_json(src, "python3 %s --gen write --root %s" % (REMOTE_SCRIPT, ROOT))
            man = wrote.get("manifest") or {}
            ledger.step("sourceWrite", ms=wrote.get("ms"), bytes=man.get("bytes"), mismatches=wrote.get("mismatches"),
                        files=len(man.get("files") or {}))
            ledger.data["sourceManifest"] = man
            if wrote.get("mismatches") != [] or not man:
                raise Refused("source write did not match the synthetic spec")
        with Phase(ledger, "sourceStop"):
            state = machines.stop(src)
            ledger.step("sourceStopped", state=state, active=budget.report())
            if state != "stopped":
                raise Refused("source is not confirmed stopped (%s)" % state)

        mgr = make_manager(ledger, outdir, src["id"], budget)
        with Phase(ledger, "managerBuild"):
            ledger.data["manager"] = mgr.build()
        with Phase(ledger, "managerBegin"):
            begin = mgr.run("begin", {"requestId": str(uuid.uuid4()), "environmentRevision": None,
                                      "machine": {"id": src["id"], "account": ACCOUNT, "status": state}})
            ledger.step("managerBegin", status=begin)
            if begin.get("state") != "pending" or not begin.get("name"):
                raise Refused("manager did not start a capture: %s" % begin)
            ledger.data["resources"].append({"kind": "snapshot", "role": "snapshot", "name": begin["name"], "id": None,
                                             "source": src["id"], "state": "manager-intent", "intentAt": _now()})
            ledger.save()
        snap = ledger.res("snapshot")
        with Phase(ledger, "capture"):
            ticks, last = 0, None
            while True:
                last = mgr.run("tick")         # budget-checked; exhaustion ends the capture wait
                ticks += 1
                item, led = mgr.item()
                done = next((d for d in led.get("done") or [] if d["name"] == snap["name"]), None)
                if item or done:
                    snap.update(state="manager-" + (item["state"] if item else done["outcome"]),
                                id=(item or done).get("id"))
                    ledger.save()
                if last.get("state") in ("active", "failed", "blocked") or (item and item["state"] == "unconfirmed"):
                    break
                sleep(max(0, min(LIMITS["tickSeconds"], budget.work_left())))
            item, led = mgr.item()
            ledger.step("managerResult", ticks=ticks, status=last, item=item and {k: item[k] for k in ("name", "id", "state", "why", "polls")},
                        done=led.get("done"))
            if not last or last.get("state") != "active" or not item or item["state"] != "active":
                raise Refused("manager did not report the capture active")
        with Phase(ledger, "ownershipProof"):
            by_name, by_id = rest.snapshot(snap["name"]), rest.snapshot(item["id"])
            proof = {"byName": _view(by_name), "byId": _view(by_id),
                     "ok": snapshot_owned(by_name, snap["name"], src["id"], item["id"])
                     and snapshot_owned(by_id, snap["name"], src["id"], item["id"])
                     and by_name.get("state") == "active" and item["id"] != ledger.data.get("baseId")}
            ledger.data["snapshotProof"] = proof
            snap.update(id=item["id"], state="active-verified" if proof["ok"] else "active-unproven")
            ledger.save()
            if not proof["ok"]:
                raise Refused("independent snapshot ownership proof failed")

        with Phase(ledger, "sourceDelete"):
            out = machines.delete(src)
            ledger.step("sourceDelete", outcome=out)
            if out != "deleted":
                raise Unknown("source deletion not confirmed; no restore machine will be created")
        with Phase(ledger, "restoreCreate"):
            # create + upload + verify + stop must fit the remaining work and active budget, or nothing is allocated
            rst = machines.create("restore", snap["name"], need=LIMITS["restoreNeedSeconds"])
        with Phase(ledger, "restoreVerify"):
            with open(os.path.abspath(__file__), encoding="utf8") as f:
                machines.upload(rst, f.read().encode("utf8"), REMOTE_SCRIPT)
            ver = machines.exec_json(rst, "python3 %s --gen verify --root %s" % (REMOTE_SCRIPT, ROOT))
            got = ver.get("manifest") or {"files": {}, "dirs": {}, "links": {}, "bytes": 0}
            vs_source = compare(ledger.data["sourceManifest"], got)
            ledger.data["restoreVerify"] = {"ok": bool(ver.get("ok")) and not vs_source, "bytes": got.get("bytes"),
                                            "files": len(got.get("files") or {}), "dirs": len(got.get("dirs") or {}),
                                            "links": len(got.get("links") or {}), "vsSpec": ver.get("mismatches"),
                                            "vsSource": vs_source, "ms": ver.get("ms")}
            ledger.save()
        with Phase(ledger, "restoreStop"):
            machines.stop(rst)
        ledger.data["result"] = "verified" if ledger.data["restoreVerify"]["ok"] else "restore-mismatch"
    except BudgetExhausted as exc:
        ledger.data["result"] = "budget-exhausted"
        ledger.data["refusal"] = sanitize(exc)
    except Refused as exc:
        ledger.data["result"] = "refused"
        ledger.data["refusal"] = sanitize(exc)
    except Unknown as exc:
        ledger.data["result"] = "unknown"
        ledger.data["unknown"] = sanitize(exc)
    except ApiError as exc:
        ledger.data["result"] = "provider-error"
        ledger.data["failure"] = {"op": exc.op, "status": exc.status, "reason": exc.reason}
    except Exception as exc:
        ledger.data["result"] = "failed"
        ledger.data["failure"] = {"type": type(exc).__name__, "status": getattr(exc, "status_code", None), "message": sanitize(exc)}
    finally:
        ledger.save()
        cleanup(ledger, rest, machines, sleep=sleep)    # never budget-gated: owned resources are always cleaned
        ledger.data["activeWall"] = budget.report()
        ledger.data["timings"]["total"] = round(budget.clock() - t0, 1)
        ledger.save()
    return ledger.data


def cleanup(ledger, rest, machines=None, sleep=time.sleep):
    out = {}
    with Phase(ledger, "cleanup"):
        try:
            machines = machines or Machines(ledger, rest, sleep=sleep)
            for rec in [r for r in ledger.data["resources"] if r["kind"] == "sandbox"]:
                if rec["state"] in ("intent", "unknown") and not rec.get("id"):
                    found = rest.sandbox(rec["name"])
                    labels = (found or {}).get("labels") or {}
                    if found and all(labels.get(k) == v for k, v in rec["labels"].items()):
                        rec.update(id=found["id"], state="created", reconciled=True)
                    else:
                        out[rec["role"]] = "unresolved-" + ("absent" if found is None else "unproven")
                        continue
                out[rec["role"]] = machines.delete(rec) if rec.get("id") else rec["state"]
        except Exception as exc:
            out["sandboxError"] = sanitize(exc)
        try:
            out["snapshot"] = snapshot_cleanup(ledger, rest, sleep)
        except Exception as exc:
            out["snapshotError"] = sanitize(exc)
        remaining = []
        for r in ledger.data["resources"]:
            if r.get("state") not in ("deleted", "absent", "refused", None):
                remaining.append({"kind": r["kind"], "role": r["role"], "name": r["name"], "id": r.get("id"), "state": r["state"]})
        ledger.data["remaining"] = remaining
        ledger.step("cleanup", outcome=out, remaining=len(remaining))
    return out


def dry_run():
    want = expected_manifest()
    return {"mode": "dry-run", "network": False, "credentialPresent": bool(os.environ.get("DAYTONA_API_KEY")),
            "account": "env:DAYTONA_API_KEY (no fallback)", "base": BASE_SNAPSHOT, "baseMustMatch": BASE_EXPECT,
            "caps": CAPS, "limits": LIMITS, "timeoutCaps": TIMEOUTS,
            "budget": "monotonic; work <= phaseSeconds - cleanupReserveSeconds; active (create intent -> confirmed "
                      "stopped/absent, not billed CPU) <= activeCpuSeconds - stopReserveSeconds; every step's timeout "
                      "clamped to the remainder; restore create needs restoreNeedSeconds; cleanup never budget-gated",
            "providerBackstops": "autoStop = min(autoStopMaxMinutes, active minutes left); ttl = autoDelete = phase "
                                 "minutes left at create",
            "synthetic": {"bytes": want["bytes"], "files": len(want["files"]),
                                                          "dirs": len(want["dirs"]), "links": len(want["links"])},
            "creates": ["sandbox %s<run>-sou (labels owner/run/role)" % PREFIX,
                        "snapshot cbak-probe<run>... via the compiled manager (POST /sandbox/{source}/snapshot)",
                        "sandbox %s<run>-res from that snapshot, only after the source is confirmed deleted" % PREFIX],
            "deletes": "only ledger resources, after exact ownership proof; snapshot by id, polled to 404",
            "neverTouches": sorted(PROTECTED_SANDBOXES) + [BASE_SNAPSHOT, "every id not recorded in the ledger"]}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--live", action="store_true", help="run the bounded live probe")
    mode.add_argument("--cleanup", action="store_true", help="clean only resources the ledger proves it created")
    mode.add_argument("--gen", choices=("write", "verify"), help="synthetic files inside the machine")
    ap.add_argument("--out", help="artifact directory for --live")
    ap.add_argument("--ledger", help="ledger for --cleanup")
    ap.add_argument("--root", default=ROOT)
    a = ap.parse_args(argv)
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if a.gen:
        print(json.dumps(gen_write(a.root) if a.gen == "write" else gen_verify(a.root), ensure_ascii=False))
        return 0
    if a.cleanup:
        ledger = Ledger.open(a.ledger)
        rest = Rest(os.path.join(os.path.dirname(os.path.abspath(a.ledger)), "rest-ops-%s.jsonl" % ledger.data["runId"]))
        print(json.dumps(cleanup(ledger, rest), ensure_ascii=False))
        return 0
    if not a.live:
        print(json.dumps(dry_run(), indent=2, ensure_ascii=False))
        return 0
    if not a.out:
        ap.error("--live needs --out")
    os.makedirs(a.out, exist_ok=True)
    run_id = uuid.uuid4().hex[:12]
    ledger = Ledger.new(os.path.join(a.out, "ledger-%s.json" % run_id), run_id)
    ledger.save()
    out = run_live(ledger, a.out)
    print(json.dumps({k: out.get(k) for k in ("runId", "result", "timings", "remaining", "restoreVerify")}, ensure_ascii=False))
    return 0 if out["result"] == "verified" and not out.get("remaining") else 2


if __name__ == "__main__":
    sys.exit(main())
