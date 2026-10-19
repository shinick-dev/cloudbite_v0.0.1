"""Offline checks for tools/cloudbite-end-backup-probe.py: synthetic spec bounds, manifest comparison, ownership proofs,
and the phase/active budget driven through the real orchestration with a fake clock, provider and Node driver.
No network, no credentials. python -B test/cloudbite-end-backup-probe.py"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("probe", os.path.join(HERE, "..", "tools", "cloudbite-end-backup-probe.py"))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

want = p.expected_manifest()
assert 28 * 1024 * 1024 < want["bytes"] <= p.LIMITS["maxSyntheticBytes"], want["bytes"]
assert "한글 폴더/파일 ✓ é.txt" in want["files"] and "emoji 🙂/name with spaces.txt" in want["files"]
assert want["files"][".config/cloudbite-probe/settings.json"]["mode"] == oct(0o600)
assert want["links"]["link-to-settings"]["target"] == ".config/cloudbite-probe/settings.json"
assert want == p.expected_manifest(), "deterministic"

# comparison: missing, extra, changed hash and changed mode are all reported
got = {g: {k: dict(v) for k, v in want[g].items()} for g in ("files", "dirs", "links")}
assert p.compare(want, got) == []
got["files"]["data/big.bin"]["sha256"] = "0" * 64
got["files"]["bin/run-probe.sh"]["mode"] = oct(0o644)
del got["dirs"]["empty"]
got["files"]["stray.txt"] = {"size": 1, "sha256": "x", "mode": oct(0o644)}
issues = {(b["rel"], b["issue"]) for b in p.compare(want, got)}
assert issues == {("data/big.bin", "sha256"), ("bin/run-probe.sh", "mode"), ("empty", "missing"), ("stray.txt", "extra")}, issues
assert ("bin/run-probe.sh", "mode") not in {(b["rel"], b["issue"]) for b in p.compare(want, got, modes=False)}

# real write/verify round trip where the platform has POSIX modes and symlinks
if os.name == "posix":
    with tempfile.TemporaryDirectory() as d:
        root = os.path.join(d, "cbbak")
        w = p.gen_write(root)
        assert w["mismatches"] == [], w["mismatches"]
        assert p.gen_verify(root)["ok"]
        with open(os.path.join(root, "data", "medium.bin"), "r+b") as f:
            f.write(b"X")
        assert not p.gen_verify(root)["ok"]

# ownership proofs: exact name + id + source + private; missing evidence is never proof
src = "11111111-2222-3333-4444-555555555555"
ok = {"id": "snap-1", "name": "cbak-probex-1", "sourceSandboxId": src, "general": False, "state": "active"}
assert p.snapshot_owned(ok, "cbak-probex-1", src, "snap-1")
assert p.snapshot_owned(ok, "cbak-probex-1", src)
for bad in ({"general": True}, {"general": None}, {"sourceSandboxId": "other"}, {"sourceSandboxId": None},
            {"name": "cbak-probex-2"}, {"id": ""}, {"id": "snap-2"}):
    assert not p.snapshot_owned({**ok, **bad}, "cbak-probex-1", src, "snap-1"), bad
assert not p.snapshot_owned(None, "cbak-probex-1", src)

base = {"name": p.BASE_SNAPSHOT, "general": True, "state": "active", "cpu": 1, "mem": 1, "disk": 3, "gpu": 0}
assert p.base_ok(base)
for bad in ({"cpu": 2}, {"general": False}, {"state": "inactive"}, {"gpu": 1}, {"name": "other"}):
    assert not p.base_ok({**base, **bad}), bad

assert p.caps_ok({"cpu": 1, "memory": 1, "disk": 3, "gpu": 0})
for bad in ({"cpu": 2}, {"memory": 2}, {"disk": 4}, {"gpu": 1}, {"cpu": None}):
    assert not p.caps_ok({"cpu": 1, "memory": 1, "disk": 3, "gpu": 0, **bad}), bad

rec = {"id": "sb-1", "name": "cbbak-probe-r-sou", "labels": {"owner": p.OWNER_LABEL, "cbbak-probe-run": "r"}}
info = {"id": "sb-1", "name": "cbbak-probe-r-sou", "labels": {"owner": p.OWNER_LABEL, "cbbak-probe-run": "r", "x": "y"}}
assert p.sandbox_owned(info, rec)
assert not p.sandbox_owned({**info, "labels": {"owner": p.OWNER_LABEL}}, rec)
assert not p.sandbox_owned({**info, "id": "sb-2"}, rec)
assert not p.sandbox_owned(info, {**rec, "id": None})

for vm in p.PROTECTED_SANDBOXES:
    try:
        p._guard_protected(vm)
        raise AssertionError("protected sandbox was addressable")
    except p.Refused:
        pass

dry = p.dry_run()
assert dry["network"] is False and dry["synthetic"]["bytes"] == want["bytes"]

# ---------------------------------------------------------------- budget: fake clock, fake provider, real orchestration
L = p.LIMITS
WORK = L["phaseSeconds"] - L["cleanupReserveSeconds"]
ACTIVE = L["activeCpuSeconds"] - L["stopReserveSeconds"]


class Clock:
    def __init__(self):
        self.t = 5000.0

    def __call__(self):
        return self.t

    def advance(self, s):
        self.t += s


class FakeRest:
    """Records every id/name addressed; refuses protected ids like the real Rest."""

    def __init__(self):
        self.sandboxes, self.snapshots, self.addressed = {}, {}, []

    def sandbox(self, x):
        p._guard_protected(x)
        self.addressed.append(x)
        return next((dict(i) for i in self.sandboxes.values() if x in (i["id"], i["name"])), None)

    def snapshot(self, x):
        self.addressed.append(x)
        if x == p.BASE_SNAPSHOT:
            return {"id": "base-1", "name": p.BASE_SNAPSHOT, "general": True, "state": "active", "cpu": 1, "mem": 1,
                    "disk": 3, "gpu": 0}
        return next((dict(i) for i in self.snapshots.values() if x in (i["id"], i["name"])), None)

    def delete_snapshot(self, sid):
        self.addressed.append(sid)
        self.snapshots.pop(sid, None)


class Result:
    def __init__(self, obj):
        self.result, self.exit_code = json.dumps(obj), 0


class FakeSandbox:
    def __init__(self, world, sid):
        self.world, self.id = world, sid
        self.fs, self.process = self, self

    def upload_file(self, data, path, timeout):
        self.world.calls.append(("upload", timeout, self.world.budget.work_left(), self.world.budget.active_left()))
        self.world.clock.advance(self.world.cost.get("upload", 1))

    def exec(self, cmd, timeout):
        w = self.world
        w.calls.append(("exec", timeout, w.budget.work_left(), w.budget.active_left()))
        w.clock.advance(w.cost.get("exec", 2))
        man = p.expected_manifest()
        return Result({"ok": True, "manifest": man, "mismatches": []})

    def stop(self, timeout):
        self.world.calls.append(("stop", timeout, None, None))
        self.world.clock.advance(1)
        self.world.rest.sandboxes[self.id]["state"] = "stopped"


class FakeClient:
    def __init__(self, world):
        self.world, self.creates, self.deletes = world, [], []

    def create(self, params, timeout):
        w = self.world
        self.creates.append(params)
        w.calls.append(("create", timeout, w.budget.work_left(), w.budget.active_left()))
        w.clock.advance(w.cost.get("create", 3))
        if w.cost.get("createUnknown"):
            raise RuntimeError("read timed out")
        sid = "sb-%d" % len(self.creates)
        w.rest.sandboxes[sid] = {"id": sid, "name": params["name"], "labels": params["labels"], "state": "started",
                                 "cpu": 1, "memory": 1, "disk": 3, "gpu": 0}
        return FakeSandbox(w, sid)

    def get(self, sid):
        return FakeSandbox(self.world, sid)

    def delete(self, sb, timeout, wait):
        self.deletes.append(sb.id)
        self.world.rest.sandboxes.pop(sb.id, None)


class World:
    """One fake run: the real run_live/Machines/Manager/cleanup code over a fake clock, provider and Node driver."""

    def __init__(self, tmp, **cost):
        self.clock, self.cost, self.calls, self.ticks = Clock(), cost, [], 0
        self.budget = p.Budget(clock=self.clock)
        self.rest = FakeRest()
        self.client = FakeClient(self)
        self.out = tmp
        self.ledger = p.Ledger.new(os.path.join(tmp, "ledger-t.json"), "t")
        self.store = None

    def machines(self, ledger, rest, budget):
        return p.Machines(ledger, rest, budget, client=self.client, params=lambda **kw: kw, sleep=lambda s: None)

    def manager(self, ledger, outdir, source_id, budget):
        m = p.Manager(ledger, outdir, source_id, budget)
        m.runner = lambda argv, timeout, **kw: self.node(m, argv, timeout)
        return m

    def node(self, m, argv, timeout):
        self.calls.append(("node", timeout, self.budget.work_left(), None))
        op = argv[argv.index("--op") + 1] if "--op" in argv else argv[2]
        key = "computer-backups:v1:" + m.owner
        name = "cbak-probe%s-1" % self.ledger.data["runId"]
        if op == "build":
            out = {"module": "fake.mjs"}
        elif op == "begin":
            self.rest.snapshots["snap-1"] = {"id": "snap-1", "name": name, "sourceSandboxId": m.source_id,
                                             "general": False, "state": "snapshotting"}
            led = {"items": [{"name": name, "id": "snap-1", "state": "pending", "why": None, "polls": 0}], "done": []}
            out = {"state": "pending", "name": name}
        else:
            self.ticks += 1
            self.clock.advance(self.cost.get("tick", 1))
            with open(m.store, encoding="utf8") as f:
                led = json.load(f)[key]
            if self.budget.elapsed() >= self.cost.get("activeAt", 20):
                led["items"][0]["state"] = "active"
                self.rest.snapshots["snap-1"]["state"] = "active"
            out = {"state": led["items"][0]["state"]}
        if op != "build":
            with open(m.store, "w", encoding="utf8") as f:
                json.dump({key: led}, f)
        return subprocess.CompletedProcess(argv, 0, json.dumps(out) + "\n", "")

    def run(self):
        return p.run_live(self.ledger, self.out, budget=self.budget, rest=self.rest, make_machines=self.machines,
                          make_manager=self.manager, sleep=lambda s: self.clock.advance(s))

    def check_common(self):
        # every bounded step got a positive timeout no larger than what remained at that moment
        for kind, t, work, active in self.calls:
            assert isinstance(t, int) and t >= 1, (kind, t)
            if kind in ("create", "upload", "exec", "node"):
                assert t <= work, (kind, t, work)
            if kind in ("create", "upload", "exec"):
                assert t <= active, (kind, t, active)
        for prm in self.client.creates:
            assert 1 <= prm["auto_stop_interval"] <= L["autoStopMaxMinutes"], prm
            assert 1 <= prm["ttl_minutes"] <= L["phaseSeconds"] // 60 and prm["auto_delete_interval"] <= prm["ttl_minutes"]
        # only ledger resources (and the public base) were ever addressed; the protected VM never
        known = {p.BASE_SNAPSHOT}
        for r in self.ledger.data["resources"]:
            known |= {r.get("id"), r.get("name")}
        assert set(self.rest.addressed) <= known, set(self.rest.addressed) - known
        assert not set(self.rest.addressed) & p.PROTECTED_SANDBOXES
        assert self.ledger.data["activeWall"]["measure"].endswith("not provider-billed CPU usage")

# A. normal fast run: verified, both machines' active time closed and within the cap, nothing left
with tempfile.TemporaryDirectory() as d:
    w = World(d)
    out = w.run()
    assert out["result"] == "verified", (out["result"], out.get("refusal"), out.get("failure"))
    assert len(w.client.creates) == 2 and out["remaining"] == []
    act = out["activeWall"]
    assert all(m["closed"] for m in act["machines"].values()) and act["activeUsed"] <= L["activeCpuSeconds"], act
    assert w.client.creates[1]["ttl_minutes"] < w.client.creates[0]["ttl_minutes"], w.client.creates   # shrinks with time
    w.check_common()

# B. slow capture leaves less than restoreNeedSeconds: no restore create, owned source + snapshot still cleaned
with tempfile.TemporaryDirectory() as d:
    w = World(d, tick=10, activeAt=WORK - L["restoreNeedSeconds"] + 30)
    out = w.run()
    assert out["result"] == "budget-exhausted" and "create restore" in out["refusal"], (out["result"], out.get("refusal"))
    assert [c["name"][-3:] for c in w.client.creates] == ["sou"], w.client.creates
    assert w.client.deletes == ["sb-1"] and w.rest.snapshots == {} and out["remaining"] == [], out["remaining"]
    assert p.Ledger.open(w.ledger.path).res("snapshot")["state"] == "deleted"
    w.check_common()

# C. capture never becomes active: ticks stop at the work budget (no more work), cleanup still deletes the snapshot
with tempfile.TemporaryDirectory() as d:
    w = World(d, tick=10, activeAt=10 ** 9)
    out = w.run()
    assert out["result"] == "budget-exhausted" and "manager tick" in out["refusal"], out.get("refusal")
    assert w.budget.elapsed() <= WORK + L["tickSeconds"] + 10, w.budget.elapsed()
    assert len(w.client.creates) == 1 and w.rest.snapshots == {} and out["remaining"] == []
    w.check_common()

# D. slow (but in-timeout) source startup/upload/command eat the active budget: no restore though phase time remains
with tempfile.TemporaryDirectory() as d:
    w = World(d, create=175, upload=115, exec=295)
    out = w.run()
    assert out["result"] == "budget-exhausted" and "create restore" in out["refusal"], out.get("refusal")
    assert len(w.client.creates) == 1 and out["remaining"] == []
    assert out["activeWall"]["machines"]["source"]["closed"]
    w.check_common()

# E. unknown create: active time stays open (counted against the cap), nothing is re-sent, cleanup reports it
with tempfile.TemporaryDirectory() as d:
    w = World(d, createUnknown=True)
    out = w.run()
    assert out["result"] == "unknown" and len(w.client.creates) == 1, out["result"]
    src = out["activeWall"]["machines"]["source"]
    assert not src["closed"] and src["seconds"] > 0, src
    assert [r["state"] for r in out["remaining"]] == ["unknown"], out["remaining"]
    try:
        w.budget.before_create("restore")
        raise AssertionError("created while an active interval was open")
    except p.BudgetExhausted:
        pass
    w.check_common()

# F. budget arithmetic: an open interval keeps growing; exhausted phase still yields a stop/cleanup timeout
c = Clock()
b = p.Budget(clock=c)
b.open("source")
c.advance(ACTIVE - 10)
try:
    b.timeout("exec source", 300, active=True)
    raise AssertionError("active budget not enforced")
except p.BudgetExhausted:
    pass
b.close("source")
c.advance(10 ** 4)
assert b.active_used() == ACTIVE - 10 and b.work_left() < 0
assert b.stop_timeout(60) >= 10
try:
    b.timeout("manager tick", 240)
    raise AssertionError("phase budget not enforced")
except p.BudgetExhausted:
    pass

# G. default invocation and --help are offline and never echo the credential
env = dict(os.environ, DAYTONA_API_KEY="probe-test-secret-value")
tool = os.path.join(HERE, "..", "tools", "cloudbite-end-backup-probe.py")
for argv in ([], ["--help"]):
    r = subprocess.run([sys.executable, "-B", tool, *argv], capture_output=True, text=True, encoding="utf8", env=env,
                       timeout=60)
    assert r.returncode == 0 and "probe-test-secret-value" not in r.stdout + r.stderr, (argv, r.returncode)
    if not argv:
        assert json.loads(r.stdout)["network"] is False
print("cloudbite-end-backup-probe: ok", file=sys.stderr)
