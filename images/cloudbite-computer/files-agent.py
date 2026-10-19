#!/usr/bin/env python3
"""CloudBite local files agent: on-demand materialization, dirty journal and end-of-session readiness.

Works on one configured workspace root only.  It never walks the tree, never evaluates shell
strings, refuses symlink crossings and path escapes, and never prints file contents or
credentials.  The journal is SQLite (WAL, synchronous=FULL) under the --state directory.

Remote I/O goes through an injected backend (contract: docs/cloudbite/files-agent-contract.md).
The CLI ships only ``UnconfiguredHttpBackend``, which refuses every call with
``transport_not_configured`` until the root wires a real transport; nothing is reported as
remotely saved without a matching canonical receipt.

Invariants: dirty, uploading, conflicted, pinned and open copies are never evicted; only
agent-created clean cache whose bytes still match the verified version is eligible, and
original workspace files are never deleted.  A download replaces nothing until its size and
SHA-256 are verified, and never replaces content that differs from the recorded clean copy.
"""
import argparse
import contextlib
import hashlib
import json
import os
import re
import shutil
import sqlite3
import stat
import sys
import time
import unicodedata
import uuid

CHUNK = 1 << 20
DEFAULT_RESERVE = 512 << 20
DEFAULT_MAX_TRANSFER = 1 << 30
LIST_LIMIT = 500
SYNC_LIMIT = 100
MAX_PATH_BYTES = 4096
MAX_NAME_BYTES = 255
FORBIDDEN_ANY = {".ssh", ".gnupg", ".aws", ".netrc", ".git-credentials"}
FORBIDDEN_TOP = {".config", ".local", ".mozilla", ".pki", ".cache"}
# Agent codes plus the cf-core FilesErrorCode names an adapter may pass through unchanged.
BACKEND_CODES = {"transport_not_configured", "store_not_configured", "base_version_conflict",
                 "stale_writer_epoch", "stale_writer", "stale_revision", "request_conflict",
                 "quota_exceeded", "too_large", "too_many_uploads", "not_found", "checksum_mismatch",
                 "hash_mismatch", "size_mismatch", "body_missing", "not_durable", "catalog_busy",
                 "commit_unknown", "invalid_upload_state"}
CONFLICT_CODES = {"base_version_conflict", "stale_writer_epoch", "stale_writer", "stale_revision"}
UNKNOWN_CODES = {"commit_unknown", "invalid_upload_state"}
UNRESOLVED = ("prepared", "sending", "unknown")
REPARSE_POINT = 0x400

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY, file_id TEXT UNIQUE, path TEXT NOT NULL, path_key TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL, state TEXT NOT NULL,
  remote_version TEXT, remote_sha TEXT, remote_size INTEGER, remote_mode INTEGER,
  base_version TEXT, local_sha TEXT, local_size INTEGER, local_mtime_ns INTEGER,
  dirty_rev INTEGER NOT NULL DEFAULT 0, active_op TEXT, pinned INTEGER NOT NULL DEFAULT 0,
  last_access REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS ops(
  request_id TEXT PRIMARY KEY, row INTEGER NOT NULL, file_id TEXT, path TEXT, base_version TEXT,
  writer_epoch INTEGER NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
  dirty_rev INTEGER NOT NULL, phase TEXT NOT NULL, upload_id TEXT, receipt TEXT, code TEXT,
  created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS leases(lease_id TEXT PRIMARY KEY, row INTEGER NOT NULL, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS fetches(row INTEGER PRIMARY KEY, temp TEXT NOT NULL);
"""


class AgentError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class BackendError(AgentError):
    """A definite rejection from the remote side; the request did not take effect."""


class UnconfiguredHttpBackend:
    """Placeholder until the root supplies the scoped server transport."""
    configured = False

    def _refuse(self, *_args, **_kwargs):
        raise BackendError("transport_not_configured")

    fetch_version = begin_upload = put_body = commit_upload = get_operation = _refuse


def check_rel(path):
    """Validate a root-relative POSIX path; returns its segments.  Unicode is kept as given."""
    if not isinstance(path, str) or not path:
        raise AgentError("path_invalid")
    try:
        encoded = path.encode("utf-8")
    except UnicodeEncodeError:
        raise AgentError("path_invalid") from None
    if len(encoded) > MAX_PATH_BYTES or "\\" in path or path.startswith("/") \
            or any(ord(c) < 32 or ord(c) == 127 for c in path):
        raise AgentError("path_invalid")
    parts = path.split("/")
    for part in parts:
        if part in ("", ".", "..") or len(part.encode("utf-8")) > MAX_NAME_BYTES:
            raise AgentError("path_invalid")
    if re.match(r"^[A-Za-z]:", parts[0]):
        raise AgentError("path_invalid")
    folded = [p.casefold() for p in parts]
    if FORBIDDEN_ANY.intersection(folded) or folded[0] in FORBIDDEN_TOP:
        raise AgentError("path_forbidden")
    return parts


def path_key(path):
    return unicodedata.normalize("NFC", path).casefold()


def _is_link(st):
    return stat.S_ISLNK(st.st_mode) or bool(getattr(st, "st_file_attributes", 0) & REPARSE_POINT)


def _open_flags(base):
    return base | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)


def _fsync_dir(path):
    if os.name == "nt":
        return
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def hash_file(path):
    """(sha256, size, mtime_ns) of a regular non-symlink file."""
    fd = os.open(path, _open_flags(os.O_RDONLY))
    with os.fdopen(fd, "rb") as handle:
        st = os.fstat(handle.fileno())
        if not stat.S_ISREG(st.st_mode):
            raise AgentError("path_invalid")
        digest, size = hashlib.sha256(), 0
        for chunk in iter(lambda: handle.read(CHUNK), b""):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size, os.stat(path).st_mtime_ns


def _int(value, minimum=0):
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise AgentError("invalid_argument")
    return value


def _ident(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", value):
        raise AgentError("invalid_argument")
    return value


def _sha(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise AgentError("invalid_argument")
    return value


class FilesAgent:
    def __init__(self, state_dir, backend=None, disk_free=None, clock=time.time):
        self.state_dir = os.path.realpath(state_dir)
        self.staging = os.path.join(self.state_dir, "staging")
        self.backend = backend or UnconfiguredHttpBackend()
        self.disk_free = disk_free or (lambda p: shutil.disk_usage(p).free)
        self.clock = clock
        if not os.path.isdir(self.staging):
            raise AgentError("not_configured")
        self.db = sqlite3.connect(os.path.join(self.state_dir, "journal.sqlite3"),
                                  isolation_level=None, timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript(SCHEMA)
        self.cfg = {r["key"]: json.loads(r["value"]) for r in self.db.execute("SELECT * FROM meta")}
        if "root" not in self.cfg:
            raise AgentError("not_configured")
        self.root = self.cfg["root"]
        self._recover()

    # ---- setup -------------------------------------------------------------------------------
    @staticmethod
    def init(state_dir, root, workspace_id, machine_id, writer_epoch=1,
             reserve_bytes=DEFAULT_RESERVE, max_transfer_bytes=DEFAULT_MAX_TRANSFER, auto_evict=False):
        root = os.path.realpath(root)
        state = os.path.realpath(state_dir)
        home = os.path.realpath(os.path.expanduser("~"))
        if not os.path.isdir(root) or os.path.dirname(root) == root:
            raise AgentError("invalid_argument")
        def within(a, b):
            try:
                return os.path.commonpath([a, b]) == b
            except ValueError:  # different drives
                return False
        if within(home, root) or within(state, root) or within(root, state):
            raise AgentError("path_forbidden")
        os.makedirs(os.path.join(state, "staging"), exist_ok=True)
        if os.stat(root).st_dev != os.stat(state).st_dev:
            raise AgentError("invalid_argument")
        cfg = {"root": root, "workspaceId": _ident(workspace_id), "machineId": _ident(machine_id),
               "writerEpoch": _int(writer_epoch, 1), "reserveBytes": _int(reserve_bytes),
               "maxTransferBytes": _int(max_transfer_bytes, 1), "autoEvict": bool(auto_evict),
               "draining": False}
        db = sqlite3.connect(os.path.join(state, "journal.sqlite3"), isolation_level=None)
        try:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript(SCHEMA)
            existing = db.execute("SELECT value FROM meta WHERE key='root'").fetchone()
            if existing and json.loads(existing[0]) != root:
                raise AgentError("invalid_argument")
            db.execute("BEGIN IMMEDIATE")
            for key, value in cfg.items():
                if key != "draining" or not existing:
                    db.execute("INSERT OR REPLACE INTO meta VALUES(?,?)", (key, json.dumps(value)))
            db.execute("COMMIT")
        finally:
            db.close()
        return FilesAgent(state)

    def _recover(self):
        """Discard only agent-owned temporaries; unconfirmed uploads become unknown, never clean."""
        with self._tx() as db:
            for row in db.execute("SELECT temp FROM fetches").fetchall():
                self._unlink_staging(row["temp"])
            db.execute("DELETE FROM fetches")
            db.execute("UPDATE ops SET phase='unknown' WHERE phase='sending'")
            live = {"upload-" + r["request_id"] for r in
                    db.execute("SELECT request_id FROM ops WHERE phase IN ('prepared','sending','unknown')")}
        for name in os.listdir(self.staging):
            if name not in live and (name.startswith("fetch-") or name.startswith("upload-")):
                self._unlink_staging(name)

    def close(self):
        self.db.close()

    @contextlib.contextmanager
    def _tx(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield self.db
        except BaseException:
            self.db.execute("ROLLBACK")
            raise
        self.db.execute("COMMIT")

    def _set_cfg(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO meta VALUES(?,?)", (key, json.dumps(value)))
        self.cfg[key] = value

    def _unlink_staging(self, name):
        with contextlib.suppress(FileNotFoundError):
            os.unlink(os.path.join(self.staging, os.path.basename(name)))

    # ---- path resolution -----------------------------------------------------------------------
    def _resolve(self, rel):
        """Absolute path under root; refuses symlink/junction components and non-directory parents."""
        parts = check_rel(rel)
        cur = self.root
        for i, part in enumerate(parts):
            cur = os.path.join(cur, part)
            try:
                st = os.lstat(cur)
            except FileNotFoundError:
                return os.path.join(self.root, *parts)
            if _is_link(st):
                raise AgentError("path_symlink")
            if (i < len(parts) - 1 and not stat.S_ISDIR(st.st_mode)) or \
                    (i == len(parts) - 1 and not stat.S_ISREG(st.st_mode)):
                raise AgentError("path_invalid")
        return cur

    def _make_parents(self, rel):
        cur = self.root
        for part in check_rel(rel)[:-1]:
            cur = os.path.join(cur, part)
            with contextlib.suppress(FileExistsError):
                os.mkdir(cur, 0o755)
            st = os.lstat(cur)
            if _is_link(st) or not stat.S_ISDIR(st.st_mode):
                raise AgentError("path_symlink" if _is_link(st) else "path_invalid")

    def _row(self, path=None, file_id=None):
        if file_id is not None:
            row = self.db.execute("SELECT * FROM files WHERE file_id=?", (file_id,)).fetchone()
        else:
            check_rel(path)
            row = self.db.execute("SELECT * FROM files WHERE path_key=?", (path_key(path),)).fetchone()
            if row and row["path"] != path:
                raise AgentError("path_collision")
        if not row:
            raise AgentError("not_found")
        return row

    # ---- catalog -------------------------------------------------------------------------------
    def register(self, entries):
        """Record remote catalog metadata.  Reads no file bodies, local or remote."""
        if not isinstance(entries, list) or len(entries) > LIST_LIMIT:
            raise AgentError("invalid_argument")
        added = updated = 0
        with self._tx() as db:
            for entry in entries:
                if not isinstance(entry, dict):
                    raise AgentError("invalid_argument")
                file_id, path = _ident(entry.get("fileId")), entry.get("path")
                version, sha = _ident(entry.get("versionId")), _sha(entry.get("sha256"))
                size = _int(entry.get("size"))
                mode = _int(entry.get("mode", 0o644)) & 0o777
                key = path_key(path) if check_rel(path) else None
                local = self._resolve(path)
                row =db.execute("SELECT * FROM files WHERE file_id=?", (file_id,)).fetchone()
                other = db.execute("SELECT * FROM files WHERE path_key=?", (key,)).fetchone()
                if other and (not row or other["id"] != row["id"]):
                    raise AgentError("path_collision")
                if row:
                    if row["path"] != path and row["state"] != "remote-only":
                        raise AgentError("busy")
                    db.execute("UPDATE files SET path=?, path_key=?, remote_version=?, remote_sha=?, "
                               "remote_size=?, remote_mode=? WHERE id=?",
                               (path, key, version, sha, size, mode, row["id"]))
                    updated += 1
                else:
                    origin = "user" if os.path.lexists(local) else "agent"
                    db.execute("INSERT INTO files(file_id,path,path_key,origin,state,remote_version,"
                               "remote_sha,remote_size,remote_mode) VALUES(?,?,?,?,?,?,?,?,?)",
                               (file_id, path, key, origin, "remote-only", version, sha, size, mode))
                    added += 1
        return {"added": added, "updated": updated}

    def list_local(self, cursor=0, limit=100):
        cursor, limit = _int(cursor), _int(limit, 1)
        if limit > LIST_LIMIT:
            raise AgentError("invalid_argument")
        rows = self.db.execute("SELECT f.*, (SELECT COUNT(*) FROM leases l WHERE l.row=f.id) AS open_count "
                               "FROM files f WHERE id>? ORDER BY id LIMIT ?", (cursor, limit + 1)).fetchall()
        items = [self._describe(r) for r in rows[:limit]]
        return {"items": items, "nextCursor": rows[limit - 1]["id"] if len(rows) > limit else None}

    def _describe(self, r):
        return {"path": r["path"], "fileId": r["file_id"], "state": r["state"], "origin": r["origin"],
                "remoteVersion": r["remote_version"], "baseVersion": r["base_version"],
                "size": r["local_size"] if r["local_size"] is not None else r["remote_size"],
                "pinned": bool(r["pinned"]), "open": r["open_count"], "evictable": self._evictable(r)}

    def _evictable(self, r):
        return r["origin"] == "agent" and r["state"] == "clean" and not r["pinned"] and not r["open_count"]

    # ---- open / materialize --------------------------------------------------------------------
    def open(self, path=None, file_id=None, version=None):
        row = self._row(path, file_id)
        expected = version or row["remote_version"]
        if expected != row["remote_version"]:
            raise AgentError("version_mismatch")
        target = self._resolve(row["path"])
        fetched = 0
        row = self._observe_local(row, target)
        if row["state"] in ("dirty", "uploading", "conflict"):
            if (version is not None or row["base_version"] is None) and row["base_version"] != expected:
                raise AgentError("local_modified")
        elif not (row["state"] == "clean" and row["base_version"] == expected):
            if os.path.lexists(target) and row["state"] == "remote-only":
                raise AgentError("local_modified")
            fetched = self._fetch(row, target, expected)
        lease = uuid.uuid4().hex
        with self._tx() as db:
            db.execute("INSERT INTO leases VALUES(?,?,?)", (lease, row["id"], self.clock()))
            db.execute("UPDATE files SET last_access=? WHERE id=?", (self.clock(), row["id"]))
        row = self._row(file_id=row["file_id"]) if row["file_id"] else self._row(row["path"])
        return {"leaseId": lease, "path": row["path"], "state": row["state"],
                "versionId": row["base_version"], "fetchedBytes": fetched}

    def _observe_local(self, row, target):
        """Detect on-disk content that differs from the journal; record it as dirty, never discard it."""
        if not os.path.lexists(target):
            if row["state"] == "clean":  # vanished cache: just remote-only again
                with self._tx() as db:
                    db.execute("UPDATE files SET state='remote-only', base_version=NULL, local_sha=NULL, "
                               "local_size=NULL, local_mtime_ns=NULL WHERE id=? AND state='clean'", (row["id"],))
                return self._reload(row)
            return row
        st = os.stat(target)
        if row["state"] != "remote-only" and (st.st_size, st.st_mtime_ns) == (row["local_size"], row["local_mtime_ns"]):
            return row
        sha, size, mtime = hash_file(target)
        with self._tx() as db:
            if row["state"] == "remote-only" and sha == row["remote_sha"]:
                db.execute("UPDATE files SET state='clean', origin='user', base_version=remote_version, "
                           "local_sha=?, local_size=?, local_mtime_ns=? WHERE id=?", (sha, size, mtime, row["id"]))
            elif sha == row["local_sha"]:
                db.execute("UPDATE files SET local_size=?, local_mtime_ns=? WHERE id=?", (size, mtime, row["id"]))
            else:
                state = row["state"] if row["state"] in ("uploading", "conflict") else "dirty"
                origin = "user" if row["state"] == "remote-only" else row["origin"]
                db.execute("UPDATE files SET state=?, origin=?, local_sha=?, local_size=?, local_mtime_ns=?, "
                           "dirty_rev=dirty_rev+1 WHERE id=?", (state, origin, sha, size, mtime, row["id"]))
        return self._reload(row)

    def _reload(self, row):
        return self.db.execute("SELECT * FROM files WHERE id=?", (row["id"],)).fetchone()

    def _fetch(self, row, target, version):
        if self.cfg.get("draining"):
            raise AgentError("draining")
        size = row["remote_size"]
        if size > self.cfg["maxTransferBytes"]:
            raise AgentError("transfer_too_large")
        self._ensure_space(size)
        temp = "fetch-" + uuid.uuid4().hex
        try:
            with self._tx() as db:
                db.execute("INSERT INTO fetches VALUES(?,?)", (row["id"], temp))
        except sqlite3.IntegrityError:
            raise AgentError("busy") from None
        temp_path = os.path.join(self.staging, temp)
        try:
            digest, written = hashlib.sha256(), 0
            fd = os.open(temp_path, _open_flags(os.O_WRONLY | os.O_CREAT | os.O_EXCL), 0o600)
            with os.fdopen(fd, "wb") as out:
                try:
                    chunks = self.backend.fetch_version({"fileId": row["file_id"], "versionId": version,
                                                         "maxBytes": size})
                    for chunk in chunks:
                        written += len(chunk)
                        if written > size:
                            raise AgentError("size_mismatch")
                        digest.update(chunk)
                        out.write(chunk)
                except AgentError:
                    raise
                except Exception:
                    raise AgentError("backend_error") from None
                out.flush()
                os.fsync(out.fileno())
            if written != size:
                raise AgentError("size_mismatch")
            if digest.hexdigest() != row["remote_sha"]:
                raise AgentError("checksum_mismatch")
            os.chmod(temp_path, row["remote_mode"] & 0o777)
            self._make_parents(row["path"])
            target = self._resolve(row["path"])
            current = self._reload(row)
            if os.path.lexists(target):
                st = os.stat(target)
                if current["state"] != "clean" or (st.st_size, st.st_mtime_ns) != \
                        (current["local_size"], current["local_mtime_ns"]):
                    raise AgentError("local_modified_unrecorded")
            elif current["state"] != row["state"]:
                raise AgentError("busy")
            os.replace(temp_path, target)
            _fsync_dir(os.path.dirname(target))
            st = os.stat(target)
            with self._tx() as db:
                db.execute("UPDATE files SET state='clean', base_version=?, local_sha=?, local_size=?, "
                           "local_mtime_ns=? WHERE id=?", (version, row["remote_sha"], size, st.st_mtime_ns, row["id"]))
                db.execute("DELETE FROM fetches WHERE row=?", (row["id"],))
            return written
        finally:
            self._unlink_staging(temp)
            with self._tx() as db:
                db.execute("DELETE FROM fetches WHERE row=? AND temp=?", (row["id"], temp))

    def close_lease(self, lease_id):
        with self._tx() as db:
            if not db.execute("DELETE FROM leases WHERE lease_id=?", (lease_id,)).rowcount:
                raise AgentError("not_found")
        return {"closed": lease_id}

    def set_pinned(self, path, pinned):
        row = self._row(path)
        with self._tx() as db:
            db.execute("UPDATE files SET pinned=? WHERE id=?", (int(bool(pinned)), row["id"]))
        return {"path": row["path"], "pinned": bool(pinned)}

    # ---- dirty journal / upload ----------------------------------------------------------------
    def mark_dirty(self, path):
        target = self._resolve(path)
        if not os.path.lexists(target):
            raise AgentError("not_found")
        sha, size, mtime = hash_file(target)
        key = path_key(path)
        with self._tx() as db:
            row = db.execute("SELECT * FROM files WHERE path_key=?", (key,)).fetchone()
            if row and row["path"] != path:
                raise AgentError("path_collision")
            if not row:
                db.execute("INSERT INTO files(path,path_key,origin,state,local_sha,local_size,local_mtime_ns,"
                           "dirty_rev) VALUES(?,?,?,?,?,?,?,1)", (path, key, "user", "dirty", sha, size, mtime))
            elif row["state"] == "clean" and sha == row["local_sha"]:
                db.execute("UPDATE files SET local_size=?, local_mtime_ns=? WHERE id=?", (size, mtime, row["id"]))
            elif row["state"] == "remote-only" and sha == row["remote_sha"]:
                db.execute("UPDATE files SET state='clean', origin='user', base_version=remote_version, "
                           "local_sha=?, local_size=?, local_mtime_ns=? WHERE id=?", (sha, size, mtime, row["id"]))
            else:
                state = row["state"] if row["state"] in ("uploading", "conflict") else "dirty"
                origin = "user" if row["state"] == "remote-only" else row["origin"]
                db.execute("UPDATE files SET state=?, origin=?, local_sha=?, local_size=?, local_mtime_ns=?, "
                           "dirty_rev=dirty_rev+1 WHERE id=?", (state, origin, sha, size, mtime, row["id"]))
            row = db.execute("SELECT * FROM files WHERE path_key=?", (key,)).fetchone()
        return {"path": row["path"], "state": row["state"], "dirtyRev": row["dirty_rev"]}

    def sync(self, limit=SYNC_LIMIT):
        limit = min(_int(limit, 1), SYNC_LIMIT)
        results = []
        retry = self.db.execute("SELECT o.request_id FROM ops o JOIN files f ON f.active_op=o.request_id "
                                "WHERE o.phase='prepared' LIMIT ?", (limit,)).fetchall()
        fresh = self.db.execute("SELECT id FROM files WHERE state='dirty' AND active_op IS NULL "
                                "ORDER BY id LIMIT ?", (limit,)).fetchall()
        for item in retry:
            results.append(self._send(item["request_id"]))
        for item in fresh[:max(0, limit - len(retry))]:
            try:
                request_id = self._prepare(item["id"])
            except AgentError as err:
                results.append({"code": err.code})
                continue
            except OSError:
                results.append({"code": "io_error"})
                continue
            if request_id:
                results.append(self._send(request_id))
        return {"results": results}

    def _prepare(self, row_id):
        """Stage an immutable snapshot and persist the operation before anything is sent."""
        row = self.db.execute("SELECT * FROM files WHERE id=?", (row_id,)).fetchone()
        source = self._resolve(row["path"])
        st = os.stat(source)
        if st.st_size > self.cfg["maxTransferBytes"]:
            raise AgentError("transfer_too_large")
        self._ensure_space(st.st_size)
        request_id = uuid.uuid4().hex
        part = os.path.join(self.staging, "upload-%s.part" % request_id)
        digest, size = hashlib.sha256(), 0
        try:
            fd = os.open(source, _open_flags(os.O_RDONLY))
            with os.fdopen(fd, "rb") as src, open(part, "xb") as out:
                for chunk in iter(lambda: src.read(CHUNK), b""):
                    digest.update(chunk)
                    size += len(chunk)
                    out.write(chunk)
                out.flush()
                os.fsync(out.fileno())
            os.replace(part, os.path.join(self.staging, "upload-" + request_id))
        except BaseException:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(part)
            raise
        with self._tx() as db:
            current = db.execute("SELECT * FROM files WHERE id=?", (row_id,)).fetchone()
            if current["state"] != "dirty" or current["active_op"] is not None:
                self._unlink_staging("upload-" + request_id)
                return None
            db.execute("INSERT INTO ops VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (request_id, row_id, current["file_id"], None if current["file_id"] else current["path"],
                        current["base_version"], self.cfg["writerEpoch"], size, digest.hexdigest(),
                        current["dirty_rev"], "prepared", None, None, None, self.clock()))
            db.execute("UPDATE files SET state='uploading', active_op=? WHERE id=?", (request_id, row_id))
        return request_id

    def _op(self, request_id):
        return self.db.execute("SELECT * FROM ops WHERE request_id=?", (request_id,)).fetchone()

    def _send(self, request_id):
        op = self._op(request_id)
        with self._tx() as db:
            db.execute("UPDATE ops SET phase='sending' WHERE request_id=? AND phase='prepared'", (request_id,))
        staged = os.path.join(self.staging, "upload-" + request_id)
        try:
            began = self.backend.begin_upload({
                "requestId": request_id, "fileId": op["file_id"], "path": op["path"],
                "baseVersion": op["base_version"], "writerEpoch": op["writer_epoch"],
                "size": op["size"], "sha256": op["sha256"]})
            if not isinstance(began, dict) or began.get("requestId") != request_id or not began.get("uploadId"):
                return self._mark_op(request_id, "unknown", "receipt_mismatch")
            upload_id = str(began["uploadId"])
            with self._tx() as db:
                db.execute("UPDATE ops SET upload_id=? WHERE request_id=?", (upload_id, request_id))
            with open(staged, "rb") as body:
                offset = 0
                for chunk in iter(lambda: body.read(CHUNK), b""):
                    self.backend.put_body({"uploadId": upload_id, "offset": offset}, chunk)
                    offset += len(chunk)
            receipt = self.backend.commit_upload({"requestId": request_id, "uploadId": upload_id})
        except BackendError as err:
            return self._rejected(request_id, err.code)
        except Exception:
            return self._mark_op(request_id, "unknown", "backend_error")
        return self._apply_receipt(request_id, receipt)

    def _mark_op(self, request_id, phase, code):
        with self._tx() as db:
            db.execute("UPDATE ops SET phase=?, code=? WHERE request_id=?", (phase, code, request_id))
        return {"requestId": request_id, "phase": phase, "code": code}

    def _rejected(self, request_id, code):
        code = code if code in BACKEND_CODES else "backend_error"
        if code in UNKNOWN_CODES:
            return self._mark_op(request_id, "unknown", code)
        op = self._op(request_id)
        if code in CONFLICT_CODES or code == "request_conflict":
            phase, state = ("conflict", "conflict") if code in CONFLICT_CODES else ("rejected", "dirty")
            with self._tx() as db:
                db.execute("UPDATE ops SET phase=?, code=? WHERE request_id=?", (phase, code, request_id))
                db.execute("UPDATE files SET state=?, active_op=NULL WHERE id=? AND active_op=?",
                           (state, op["row"], request_id))
            self._unlink_staging("upload-" + request_id)
            return {"requestId": request_id, "phase": phase, "code": code}
        return self._mark_op(request_id, "prepared", code)  # definite refusal: retry later, same id

    def _receipt_ok(self, op, r):
        return (isinstance(r, dict) and r.get("canonical") is True and r.get("requestId") == op["request_id"]
                and isinstance(r.get("versionId"), str) and bool(r["versionId"])
                and r["versionId"] != op["base_version"]
                and isinstance(r.get("fileId"), str) and bool(r["fileId"])
                and (op["file_id"] is None or r["fileId"] == op["file_id"])
                and r.get("sha256") == op["sha256"] and r.get("size") == op["size"]
                and not isinstance(r.get("size"), bool)
                and r.get("baseVersion") == op["base_version"] and r.get("writerEpoch") == op["writer_epoch"])

    def apply_ack(self, receipt):
        """Accept an asynchronously delivered receipt; stale or mismatched acks change nothing."""
        request_id = receipt.get("requestId") if isinstance(receipt, dict) else None
        if not isinstance(request_id, str) or not self._op(request_id):
            raise AgentError("not_found")
        return self._apply_receipt(request_id, receipt)

    def _apply_receipt(self, request_id, receipt):
        op = self._op(request_id)
        row = self.db.execute("SELECT * FROM files WHERE id=?", (op["row"],)).fetchone()
        if op["phase"] not in UNRESOLVED or row["active_op"] != request_id:
            return {"requestId": request_id, "phase": op["phase"], "applied": False, "code": "stale_ack"}
        if not self._receipt_ok(op, receipt):
            return self._mark_op(request_id, "unknown", "receipt_mismatch")
        try:
            sha, size, mtime = hash_file(self._resolve(row["path"]))
        except (OSError, AgentError):
            sha = size = mtime = None
        clean = sha == op["sha256"]
        with self._tx() as db:
            db.execute("UPDATE ops SET phase='committed', code=NULL, receipt=? WHERE request_id=?",
                       (json.dumps(receipt, sort_keys=True), request_id))
            db.execute("UPDATE files SET file_id=?, remote_version=?, remote_sha=?, remote_size=?, base_version=?, "
                       "active_op=NULL, state=?, local_sha=COALESCE(?, local_sha), local_size=COALESCE(?, local_size), "
                       "local_mtime_ns=COALESCE(?, local_mtime_ns), dirty_rev=dirty_rev+? WHERE id=?",
                       (receipt["fileId"], receipt["versionId"], op["sha256"], op["size"], receipt["versionId"],
                        "clean" if clean else "dirty", sha, size, mtime, 0 if clean else 1, row["id"]))
        self._unlink_staging("upload-" + request_id)
        return {"requestId": request_id, "phase": "committed", "versionId": receipt["versionId"],
                "state": "clean" if clean else "dirty"}

    def reconcile(self):
        results = []
        for op in self.db.execute("SELECT request_id FROM ops WHERE phase IN ('sending','unknown')").fetchall():
            request_id = op["request_id"]
            try:
                answer = self.backend.get_operation({"requestId": request_id,
                                                     "uploadId": self._op(request_id)["upload_id"]})
            except BackendError as err:
                results.append({"requestId": request_id, "phase": "unknown", "code": err.code})
                continue
            except Exception:
                results.append({"requestId": request_id, "phase": "unknown", "code": "backend_error"})
                continue
            phase = answer.get("phase") if isinstance(answer, dict) and answer.get("requestId") == request_id else None
            if phase == "committed":
                results.append(self._apply_receipt(request_id, answer.get("receipt")))
            elif phase == "unknown_request":
                results.append(self._mark_op(request_id, "prepared", None))  # never landed: resend same id
            elif phase == "conflict":
                results.append(self._rejected(request_id, answer.get("code") or "base_version_conflict"))
            elif phase == "rejected":
                results.append(self._rejected(request_id, "request_conflict"))
            else:
                results.append({"requestId": request_id, "phase": "unknown", "code": "pending"})
        return {"results": results}

    # ---- space -----------------------------------------------------------------------------------
    def _ensure_space(self, needed):
        shortfall = needed + self.cfg["reserveBytes"] - self.disk_free(self.root)
        if shortfall > 0 and self.cfg.get("autoEvict"):
            self.evict(shortfall)
            shortfall = needed + self.cfg["reserveBytes"] - self.disk_free(self.root)
        if shortfall > 0:
            raise AgentError("insufficient_space")

    def evict(self, need_bytes=None):
        """Remove verified clean agent-created cache, least recently used first."""
        freed, evicted = 0, []
        rows = self.db.execute("SELECT f.*, (SELECT COUNT(*) FROM leases l WHERE l.row=f.id) AS open_count "
                               "FROM files f WHERE origin='agent' AND state='clean' AND pinned=0 "
                               "ORDER BY last_access, id").fetchall()
        for row in rows:
            if need_bytes is not None and freed >= need_bytes:
                break
            if not self._evictable(row) or self.db.execute(
                    "SELECT 1 FROM fetches WHERE row=?", (row["id"],)).fetchone():
                continue
            try:
                target = self._resolve(row["path"])
                sha, size, mtime = hash_file(target)
            except (OSError, AgentError):
                continue
            if sha != row["local_sha"]:  # changed without a journal entry: keep it as dirty work
                self._observe_local(row, target)
                continue
            with self._tx() as db:
                if db.execute("SELECT 1 FROM leases WHERE row=?", (row["id"],)).fetchone():
                    continue
                if (os.stat(target).st_size, os.stat(target).st_mtime_ns) != (size, mtime):
                    continue
                os.unlink(target)
                db.execute("UPDATE files SET state='remote-only', base_version=NULL, local_sha=NULL, "
                           "local_size=NULL, local_mtime_ns=NULL WHERE id=?", (row["id"],))
            freed += size
            evicted.append(row["path"])
        return {"evicted": evicted, "freedBytes": freed}

    # ---- session -------------------------------------------------------------------------------
    def status(self):
        counts = {r["state"]: r["n"] for r in self.db.execute("SELECT state, COUNT(*) n FROM files GROUP BY state")}
        unresolved = self.db.execute("SELECT COUNT(*) FROM ops WHERE phase IN ('prepared','sending','unknown')"
                                     ).fetchone()[0]
        return {"workspaceId": self.cfg["workspaceId"], "machineId": self.cfg["machineId"],
                "draining": bool(self.cfg.get("draining")), "states": counts, "unconfirmedOps": unresolved,
                "openLeases": self.db.execute("SELECT COUNT(*) FROM leases").fetchone()[0],
                "pinned": self.db.execute("SELECT COUNT(*) FROM files WHERE pinned=1").fetchone()[0],
                "transportConfigured": bool(getattr(self.backend, "configured", True)),
                "freeBytes": self.disk_free(self.root), "reserveBytes": self.cfg["reserveBytes"],
                "autoEvict": bool(self.cfg.get("autoEvict"))}

    def prepare_end(self, flush=False):
        """Enter draining and report what still blocks a remote-saved / safe-to-delete claim."""
        with self._tx():
            self._set_cfg("draining", True)
        errors = []
        if flush:
            for step in (self.reconcile, self.sync, self.reconcile):
                for result in step()["results"]:
                    if result.get("code") and result.get("code") != "stale_ack":
                        errors.append(result["code"])
        paths = lambda state: [r["path"] for r in self.db.execute(
            "SELECT path FROM files WHERE state=? ORDER BY id LIMIT ?", (state, LIST_LIMIT))]
        report = {"dirty": paths("dirty"), "uploading": paths("uploading"), "conflict": paths("conflict"),
                  "unconfirmedOps": [r[0] for r in self.db.execute(
                      "SELECT request_id FROM ops WHERE phase IN ('prepared','sending','unknown') LIMIT ?",
                      (LIST_LIMIT,))],
                  "open": [r[0] for r in self.db.execute(
                      "SELECT f.path FROM files f WHERE EXISTS (SELECT 1 FROM leases l WHERE l.row=f.id) ORDER BY f.id LIMIT ?", (LIST_LIMIT,))]}
        ready = not any(report.values())
        report.update({"ready": ready, "remoteSaved": ready, "safeToDelete": ready,
                       "errors": sorted(set(errors))})
        return report

    def resume(self):
        with self._tx():
            self._set_cfg("draining", False)
        return {"draining": False}


def main(argv=None, backend=None):
    parser = argparse.ArgumentParser(prog="files-agent.py", description=__doc__.splitlines()[0])
    parser.add_argument("--state", required=True, help="agent state directory (journal and staging)")
    sub = parser.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init", help="configure the single allowlisted workspace root")
    init.add_argument("--root", required=True)
    init.add_argument("--workspace-id", required=True)
    init.add_argument("--machine-id", required=True)
    init.add_argument("--writer-epoch", type=int, default=1)
    init.add_argument("--reserve-bytes", type=int, default=DEFAULT_RESERVE)
    init.add_argument("--max-transfer-bytes", type=int, default=DEFAULT_MAX_TRANSFER)
    init.add_argument("--auto-evict", action="store_true", help="evict clean agent cache under space pressure")
    sub.add_parser("status", help="counts and readiness; reads no file bodies")
    lst = sub.add_parser("list-local", help="paged metadata of journaled files")
    lst.add_argument("--cursor", type=int, default=0)
    lst.add_argument("--limit", type=int, default=100)
    reg = sub.add_parser("register", help="record catalog metadata from a JSON manifest file")
    reg.add_argument("--manifest", required=True)
    opn = sub.add_parser("open", help="materialize the expected version and take an open lease")
    grp = opn.add_mutually_exclusive_group(required=True)
    grp.add_argument("--path")
    grp.add_argument("--file-id")
    opn.add_argument("--version")
    cls = sub.add_parser("close", help="release an open lease")
    cls.add_argument("--lease", required=True)
    for name in ("pin", "unpin", "mark-dirty"):
        sub.add_parser(name).add_argument("--path", required=True)
    syn = sub.add_parser("sync", help="upload dirty files through the configured transport")
    syn.add_argument("--limit", type=int, default=SYNC_LIMIT)
    sub.add_parser("reconcile", help="resolve unknown upload outcomes by request id")
    ev = sub.add_parser("evict", help="remove verified clean agent cache")
    ev.add_argument("--need-bytes", type=int)
    end = sub.add_parser("prepare-end", help="drain and report end-of-session readiness")
    end.add_argument("--flush", action="store_true")
    sub.add_parser("resume", help="leave draining")
    args = parser.parse_args(argv)
    with contextlib.suppress(AttributeError):
        sys.stdout.reconfigure(encoding="utf-8")
    agent = None
    try:
        if args.command == "init":
            agent = FilesAgent.init(args.state, args.root, args.workspace_id, args.machine_id, args.writer_epoch,
                                    args.reserve_bytes, args.max_transfer_bytes, args.auto_evict)
            result = {"configured": True}
        else:
            agent = FilesAgent(args.state, backend=backend)
            if args.command == "register":
                with open(args.manifest, "rb") as handle:
                    raw = handle.read(16 << 20)
                try:
                    entries = json.loads(raw.decode("utf-8"))
                except ValueError:
                    raise AgentError("invalid_argument") from None
                result = agent.register(entries)
            else:
                result = {
                    "status": lambda: agent.status(),
                    "list-local": lambda: agent.list_local(args.cursor, args.limit),
                    "open": lambda: agent.open(args.path, args.file_id, args.version),
                    "close": lambda: agent.close_lease(args.lease),
                    "pin": lambda: agent.set_pinned(args.path, True),
                    "unpin": lambda: agent.set_pinned(args.path, False),
                    "mark-dirty": lambda: agent.mark_dirty(args.path),
                    "sync": lambda: agent.sync(args.limit),
                    "reconcile": lambda: agent.reconcile(),
                    "evict": lambda: agent.evict(args.need_bytes),
                    "prepare-end": lambda: agent.prepare_end(args.flush),
                    "resume": lambda: agent.resume(),
                }[args.command]()
    except AgentError as err:
        print(json.dumps({"ok": False, "code": err.code}))
        return 2
    except OSError:
        print(json.dumps({"ok": False, "code": "io_error"}))
        return 2
    finally:
        if agent:
            agent.close()
    print(json.dumps(dict(ok=True, **result), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
