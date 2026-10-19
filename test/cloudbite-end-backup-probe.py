"""Offline checks for tools/cloudbite-end-backup-probe.py: synthetic spec bounds, manifest comparison, ownership proofs.
No network, no credentials. python -B test/cloudbite-end-backup-probe.py"""
import importlib.util
import os
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
print("cloudbite-end-backup-probe: ok", file=sys.stderr)
