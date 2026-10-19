#!/usr/bin/env python3
"""Storage capability probe (tools/cloudbite-files-storage-probe.py) against network fakes.

    python -B test/cloudbite-files-storage-probe.py

No Daytona call is made.  The fakes check the ledger-before-create rule, quota refusal,
unknown-create reconciliation without re-sending, and that cleanup deletes only resources
the ledger proves it created.  The file matrix runs on a local temp directory; that is a
semantics smoke check of the probe itself, never live persistence evidence.
"""
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "..", "tools", "cloudbite-files-storage-probe.py")
checks = 0


def ok(cond, name):
    global checks
    if not cond:
        sys.exit("FAIL: " + name)
    checks += 1


spec = importlib.util.spec_from_file_location("probe", TOOL)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class HttpError(Exception):
    def __init__(self, msg, status_code=None):
        super().__init__(msg)
        self.status_code = status_code


class ConnectionTimeout(Exception):
    status_code = None


class FakeProvider:
    delete_wait = 0

    def __init__(self, ledger_path, fail=None, local_root=None):
        self.ledger_path, self.fail = ledger_path, fail or {}
        self.volumes = {"foreign-vol": {"id": "foreign-vol", "name": "user-data", "state": "ready"}}
        self.sandboxes = {"1af294ee-b648-461c-a78a-039695413922": {"id": "1af294ee-b648-461c-a78a-039695413922",
                                                                  "name": "user-vm", "labels": {}, "state": "started"}}
        self.calls, self.local_root, self.intents_seen = [], local_root, []

    def sleep(self, s):
        pass

    def _ledger_intent(self, kind):
        with open(self.ledger_path, encoding="utf8") as f:
            data = json.load(f)
        rec = next((r for r in data["resources"] if r["kind"] == kind), None)
        self.intents_seen.append((kind, rec and rec["state"]))

    def volume_list(self):
        self.calls.append("volume_list")
        return list(self.volumes.values())

    def volume_find(self, name):
        self.calls.append("volume_find")
        return next((v for v in self.volumes.values() if v["name"] == name), None)

    def volume_create(self, name):
        self.calls.append("volume_create")
        self._ledger_intent("volume")
        mode = self.fail.get("volume_create")
        if mode == "quota":
            raise HttpError("volume quota exceeded", 403)
        vid = "vol-" + name
        if mode in ("unknown-made", "unknown-lost"):
            if mode == "unknown-made":
                self.volumes[vid] = {"id": vid, "name": name, "state": "ready"}
            raise ConnectionTimeout("read timed out")
        self.volumes[vid] = {"id": vid, "name": name, "state": "ready"}
        return {"id": vid}

    def volume_get(self, vid):
        return self.volumes.get(vid)

    def wait_volume_ready(self, vid):
        return self.volumes[vid]["state"]

    def volume_delete(self, vid):
        self.calls.append("volume_delete:" + vid)
        if any(s.get("mount") == vid for s in self.sandboxes.values()):
            raise HttpError("mounted", 409)
        del self.volumes[vid]

    def sandbox_create(self, spec):
        self.calls.append("sandbox_create")
        self._ledger_intent("sandbox")
        self.spec = spec
        mode = self.fail.get("sandbox_create")
        if mode == "quota":
            raise HttpError("Total CPU limit exceeded", 403)
        sid = "sb-" + spec["labels"]["cbfs-probe-run"]
        self.sandboxes[sid] = {"id": sid, "name": spec["name"], "labels": dict(spec["labels"]),
                               "state": "started", "mount": spec["volumes"][0]["volumeId"]}
        if mode == "unknown-made":
            raise HttpError("bad gateway", 502)
        return {"id": sid}

    def sandbox_find(self, run_id, name):
        hits = [s for s in self.sandboxes.values() if s["labels"].get("cbfs-probe-run") == run_id and s["name"] == name]
        return hits[0] if len(hits) == 1 else None

    def sandbox_get(self, sid):
        return self.sandboxes.get(sid)

    def sandbox_state(self, sid):
        return self.sandboxes[sid]["state"]

    def sandbox_stop(self, sid):
        self.calls.append("sandbox_stop:" + sid)
        self.sandboxes[sid]["state"] = "stopped"

    def sandbox_start(self, sid):
        self.calls.append("sandbox_start:" + sid)
        self.sandboxes[sid]["state"] = "started"

    def sandbox_delete(self, sid):
        self.calls.append("sandbox_delete:" + sid)
        del self.sandboxes[sid]

    def upload(self, sid, data, path):
        self.calls.append("upload")

    def exec(self, sid, cmd, timeout=300):
        return {"exit": 0, "output": "3.12.0 x86_64\n1000\n"}

    def exec_json(self, sid, cmd):
        # Map the remote roots onto a local directory so the real matrix code runs.
        args = cmd.split()
        root = args[args.index("--root") + 1].lstrip("/").replace("/", os.sep)
        root = os.path.join(self.local_root, root)
        if "write" in args:
            return probe.matrix_write(root, 1)
        return probe.matrix_verify(root)


def fresh(run_id="t1"):
    d = tempfile.mkdtemp()
    path = os.path.join(d, "storage-ledger.json")
    return d, path, probe.Ledger.open(path, run_id)


plan = dict(probe.DEFAULT_PLAN, bigFileMiB=1)

# --help and --dry-run need no network or credential.
r = subprocess.run([sys.executable, "-B", TOOL, "--help"], capture_output=True, text=True)
ok(r.returncode == 0 and "--dry-run" in r.stdout and "--live" in r.stdout, "--help runs")
env = dict(os.environ, DAYTONA_API_KEY="sk-test-secret-value")
r = subprocess.run([sys.executable, "-B", TOOL, "--dry-run"], capture_output=True, text=True, env=env)
dr = json.loads(r.stdout)
ok(r.returncode == 0 and dr["network"] is False and dr["credentialPresent"] is True, "dry-run is offline")
ok("sk-test-secret-value" not in r.stdout + r.stderr, "dry-run never prints the key")
ok(dr["plan"]["ttlMinutes"] <= 60 and dr["creates"][1]["gpu"] == 0, "dry-run plan within budget")
r = subprocess.run([sys.executable, "-B", TOOL, "--live"], capture_output=True, text=True)
ok(r.returncode != 0 and "--ledger" in r.stderr, "live requires a ledger")

# Budget gate.
for bad, why in ((dict(plan, ttlMinutes=61), "ttl"), (dict(plan, gpu=1), "gpu"), (dict(plan, bigFileMiB=1100), "bytes")):
    try:
        probe.check_plan(bad)
        ok(False, "budget refuses " + why)
    except probe.Refused:
        ok(True, "budget refuses " + why)

# Error classification.
ok(probe.classify(HttpError("x", 403)) == "refused", "403 refused")
ok(probe.classify(HttpError("Total CPU quota exceeded", 400)) == "refused", "quota text refused")
ok(probe.classify(ConnectionTimeout("t")) == "unknown", "timeout unknown")
ok(probe.classify(HttpError("x", 502)) == "unknown", "5xx unknown")
ok(probe.classify(HttpError("x", 422)) == "failed", "4xx failed")
os.environ["DAYTONA_API_KEY"] = "sk-test-secret-value"
ok(probe.redact(HttpError("bad key sk-test-secret-value"))["message"] == "bad key <redacted>", "errors redact the key")

# Happy path: intents before creates, matrix on both roots, restart verify, owned cleanup only.
d, path, led = fresh()
fp = FakeProvider(path, local_root=d)
out = probe.run_live(led, fp, plan, "source")
ok(out["result"] == "completed" and out["proof"]["verified"] and out["proof"]["kind"] == "live", "happy path verified")
ok(fp.intents_seen == [("volume", "intent"), ("sandbox", "intent")], "ledger intent persisted before each create")
ok(fp.calls.count("volume_create") == 1 and fp.calls.count("sandbox_create") == 1, "one create each")
ok(fp.spec["ttlMinutes"] == 60 and fp.spec["gpu"] == 0 and fp.spec["labels"]["owner"] == probe.OWNER_LABEL, "sandbox safety spec")
ok("sandbox_delete:sb-t1" in fp.calls and "volume_delete:vol-cbfs-probe-t1" in fp.calls, "owned resources cleaned")
ok("1af294ee-b648-461c-a78a-039695413922" in fp.sandboxes and "foreign-vol" in fp.volumes, "foreign resources untouched")
ok(not any("1af294ee" in c or "foreign" in c for c in fp.calls), "no call names a foreign resource")
writes = [s for s in out["steps"] if s["step"] == "matrixWrite"]
ok(len(writes) == 2 and writes[0]["result"]["checks"]["rangeRead"]["value"] is True, "matrix wrote both roots, range read")
ok(writes[0]["result"]["checks"]["unicodePath"]["ok"] and writes[0]["result"]["checks"]["emptyDir"]["value"] == [], "unicode + empty dir")
stopped = next(s for s in out["steps"] if s["step"] == "stoppedObservation")
ok(stopped["sandboxState"] == "stopped" and stopped["volumeContentApi"].startswith("none"), "stopped observation recorded")
ok(set(out["unmeasured"]) >= {"snapshotBoundary", "separateMachineReconnect"}, "unmeasured semantics listed, not claimed")
saved = json.load(open(path, encoding="utf8"))
ok(all(r["state"] == "deleted" for r in saved["resources"]), "ledger records deletion")
ok("sk-test-secret-value" not in open(path, encoding="utf8").read(), "ledger has no key")

# Matrix verify catches a changed byte.
mroot = os.path.join(d, "home", "daytona", "cbfs-local", "t1")
with open(os.path.join(mroot, "small.txt"), "ab") as f:
    f.write(b"!")
ok(probe.matrix_verify(mroot)["ok"] is False, "verify detects changed content")

# Quota on sandbox create: recorded refusal, no retry, owned volume cleaned, nothing else.
d, path, led = fresh("t2")
fp = FakeProvider(path, fail={"sandbox_create": "quota"}, local_root=d)
out = probe.run_live(led, fp, plan, "source")
ok(out["result"] == "account-or-plan-refused" and "CPU limit" in out["refusal"], "quota is a real result")
ok(fp.calls.count("sandbox_create") == 1, "quota not retried")
ok("volume_delete:vol-cbfs-probe-t2" in fp.calls and not any(c.startswith("sandbox_delete") for c in fp.calls), "only owned volume cleaned")
ok(next(r for r in out["resources"] if r["kind"] == "sandbox")["state"] == "refused", "sandbox intent marked refused")

# Volume quota: nothing created, nothing deleted.
d, path, led = fresh("t3")
fp = FakeProvider(path, fail={"volume_create": "quota"}, local_root=d)
out = probe.run_live(led, fp, plan, "source")
ok(out["result"] == "account-or-plan-refused" and "sandbox_create" not in fp.calls, "volume quota stops before sandbox")
ok(not any("delete" in c for c in fp.calls), "nothing deleted after volume refusal")

# Unknown create that did happen: reconciled by exact name, never re-sent.
d, path, led = fresh("t4")
fp = FakeProvider(path, fail={"volume_create": "unknown-made"}, local_root=d)
out = probe.run_live(led, fp, plan, "source")
vol = next(r for r in out["resources"] if r["kind"] == "volume")
ok(out["result"] == "completed" and vol["reconciled"] and fp.calls.count("volume_create") == 1, "unknown volume reconciled once")

# Unknown sandbox create (502) that did happen: reconciled by label+name.
d, path, led = fresh("t5")
fp = FakeProvider(path, fail={"sandbox_create": "unknown-made"}, local_root=d)
out = probe.run_live(led, fp, plan, "source")
ok(out["result"] == "completed" and fp.calls.count("sandbox_create") == 1, "unknown sandbox reconciled once")

# Unknown create not found: stop, keep ledger, no cleanup, no re-send even on rerun of create().
d, path, led = fresh("t6")
fp = FakeProvider(path, fail={"volume_create": "unknown-lost"}, local_root=d)
out = probe.run_live(led, fp, plan, "source")
ok(out["result"] == "unknown-create" and fp.calls.count("volume_create") == 1, "lost create not re-sent")
ok(not any("delete" in c for c in fp.calls), "no cleanup on unknown create")
try:
    probe.create(led, "volume", fp, lambda: fp.volume_create(led.data["name"]), lambda: fp.volume_find(led.data["name"]))
    ok(False, "replayed create stays unknown")
except probe.Unknown:
    ok(fp.calls.count("volume_create") == 1, "replayed create stays unknown without re-send")
fp.volumes["vol-late"] = {"id": "vol-late", "name": led.data["name"], "state": "ready"}
rec = probe.create(led, "volume", fp, lambda: fp.volume_create("x"), lambda: fp.volume_find(led.data["name"]))
ok(rec["id"] == "vol-late" and fp.calls.count("volume_create") == 1, "late appearance reconciled, not re-created")

# Cleanup ownership: tampered/foreign ids are refused.
d, path, led = fresh("t7")
fp = FakeProvider(path, local_root=d)
led.data["resources"] = [{"kind": "sandbox", "name": led.data["name"], "state": "created", "id": "1af294ee-b648-461c-a78a-039695413922"},
                         {"kind": "volume", "name": led.data["name"], "state": "created", "id": "foreign-vol"}]
led.data["proof"] = {"verified": True}
res = probe.cleanup(led, fp)
ok(res == {"sandbox": "refused-not-owned", "volume": "refused-not-owned"}, "cleanup refuses foreign ids")
ok(not any("delete" in c for c in fp.calls), "foreign resources never deleted")
fp.sandboxes["sb-imposter"] = {"id": "sb-imposter", "name": led.data["name"], "labels": {"cbfs-probe-run": "t7"}, "state": "started"}
led.data["resources"][0]["id"] = "sb-imposter"
ok(probe.cleanup(led, fp)["sandbox"] == "refused-not-owned", "same name without owner label refused")

# Volume without proof is kept; 409 while detaching retried within the wait only.
d, path, led = fresh("t8")
fp = FakeProvider(path, local_root=d)
fp.volumes["v8"] = {"id": "v8", "name": led.data["name"], "state": "ready"}
led.data["resources"] = [{"kind": "volume", "name": led.data["name"], "state": "created", "id": "v8"}]
ok(probe.cleanup(led, fp)["volume"] == "kept-no-proof", "volume kept without proof")
fp.sandboxes["other"] = {"id": "other", "name": "x", "labels": {}, "mount": "v8"}
led.data["proof"] = {"verified": True}
ok(probe.cleanup(led, fp)["volume"] == "delete-uncertain", "409 reported as cleanup uncertainty")

# --matrix CLI on a local root prints one JSON line.
root = os.path.join(tempfile.mkdtemp(), "m")
r = subprocess.run([sys.executable, "-B", TOOL, "--matrix", "write", "--root", root, "--big-mib", "1"], capture_output=True, text=True, encoding="utf8")
ok(r.returncode == 0 and json.loads(r.stdout.strip().splitlines()[-1])["checks"]["writeBigFsync"]["ok"], "matrix write CLI")
r = subprocess.run([sys.executable, "-B", TOOL, "--matrix", "verify", "--root", root], capture_output=True, text=True, encoding="utf8")
ok(r.returncode == 0 and json.loads(r.stdout.strip().splitlines()[-1])["ok"], "matrix verify CLI")

print("cloudbite-files-storage-probe: %d checks passed (network fakes + local matrix; no live evidence)" % checks)
