#!/usr/bin/env python3
"""CloudBite local files agent: on-demand materialization, dirty journal and end-of-session readiness.

Works on one configured workspace root only.  It never walks the tree, never evaluates shell
strings, refuses symlink crossings and path escapes, and never prints file contents or
credentials.  The journal is SQLite (WAL, synchronous=FULL) under the --state directory.

Remote I/O goes through an injected backend (contract: docs/cloudbite/files-agent-contract.md).
``HttpBackend`` talks to the CloudBite app over HTTPS with one private, machine-scoped capability
file (``--capability``); without it the CLI uses ``UnconfiguredHttpBackend``, which refuses every
call with ``transport_not_configured``.  Nothing is reported as remotely saved without a matching
canonical receipt.

Invariants: dirty, uploading, conflicted, pinned and open copies are never evicted; only
agent-created clean cache whose bytes still match the verified version is eligible, and
original workspace files are never deleted.  Eviction (explicit ``evict`` and auto-evict) runs
only when the backend declares ``eviction_policy = "verified"``; the HTTP transports do not yet
(server-effective pins and live persistence are unproven), so with them eviction is gated off.  A download replaces nothing until its size and
SHA-256 are verified, and never replaces content that differs from the recorded clean copy.
"""
import argparse
import contextlib
import hashlib
import http.client
import json
import os
import re
import shutil
import socket
import sqlite3
import ssl
import stat
import sys
import time
import unicodedata
import urllib.parse
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
                 "commit_unknown", "invalid_upload_state", "name_conflict", "catalog_unavailable",
                 "blob_unavailable", "capability_invalid", "capability_expired", "invalid_request",
                 "invalid_name", "is_a_directory", "not_a_directory", "not_verified", "too_many_children",
                 "depth_exceeded", "not_running", "version_mismatch"}
CONFLICT_CODES = {"base_version_conflict", "stale_writer_epoch", "stale_writer", "stale_revision", "name_conflict"}
UNKNOWN_CODES = {"commit_unknown", "invalid_upload_state"}
UNRESOLVED = ("prepared", "sending", "unknown")
REPARSE_POINT = 0x400
CAPABILITY_SCHEMA = "cloudbite.files.agent-capability.v1"
AGENT_PREFIX = "/p/_cloudbite/computer/files/agent/v1"
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
MAX_JSON_BYTES = 1 << 20
MAX_CAPABILITY_BYTES = 16 << 10

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
CREATE TABLE IF NOT EXISTS dirs(dir_id TEXT PRIMARY KEY, path TEXT NOT NULL, path_key TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS dir_ops(path_key TEXT PRIMARY KEY, path TEXT NOT NULL, request_id TEXT NOT NULL,
  parent_id TEXT NOT NULL, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reports(file_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, version TEXT,
  dirty INTEGER NOT NULL, acked INTEGER NOT NULL);
"""
OPS_EXTRA = (("parent_id", "TEXT"), ("name", "TEXT"))


class AgentError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class BackendError(AgentError):
    """A definite rejection from the remote side; the request did not take effect."""


class UnconfiguredHttpBackend:
    """Placeholder until the root supplies the scoped server transport."""
    configured = False
    eviction_policy = None  # gated: nothing is remotely verified

    def _refuse(self, *_args, **_kwargs):
        raise BackendError("transport_not_configured")

    fetch_version = begin_upload = put_body = commit_upload = get_operation = _refuse
    create_entry = record_local_state = _refuse


class TransportUnknown(Exception):
    """No definite answer (network loss, timeout, redirect, malformed or mismatched reply): outcome unknown."""


def _nfc(value):
    return unicodedata.normalize("NFC", value) if isinstance(value, str) else value


class HttpBackend:
    """Scoped HTTPS transport to the CloudBite files agent routes (docs/cloudbite/files-bridge.md).

    The capability file is private (0600, owned by this user) and names exactly one endpoint (gateway
    origin + ``AGENT_PREFIX``), machine, workspace and writer epoch.  The token goes only into the
    Authorization header of requests to that endpoint; redirects are never followed and nothing here
    logs or returns it."""
    configured = True
    # Gated until live persistence and server-side effective pins reaching this agent are validated:
    # a clean local cache alone does not prove the canonical copy survives, so nothing is ever evicted.
    eviction_policy = None

    def __init__(self, config, clock=time.time, timeout=30, connect=None):
        if not isinstance(config, dict) or config.get("schema") != CAPABILITY_SCHEMA \
                or not isinstance(config.get("endpoint"), str):
            raise AgentError("capability_invalid")
        parts = urllib.parse.urlsplit(config["endpoint"])
        loopback = parts.hostname in LOOPBACK
        if not (parts.scheme == "https" or (parts.scheme == "http" and loopback)) or not parts.hostname \
                or parts.username or parts.password or parts.path != AGENT_PREFIX or parts.query or parts.fragment \
                or "?" in config["endpoint"] or "#" in config["endpoint"]:
            raise AgentError("capability_invalid")
        token = config.get("token")
        if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9._~+/=-]{32,512}", token):
            raise AgentError("capability_invalid")
        try:
            port = parts.port
        except ValueError:
            raise AgentError("capability_invalid") from None
        try:
            self.scope = {"machineId": _ident(config.get("machineId")),
                          "workspaceId": _ident(config.get("workspaceId")),
                          "writerEpoch": _int(config.get("writerEpoch"), 1)}
            self.expires_at = _int(config.get("expiresAt"), 1)
        except AgentError:
            raise AgentError("capability_invalid") from None
        self._secure, self._host, self._port = parts.scheme == "https", parts.hostname, port
        self._token, self._clock, self._timeout = token, clock, timeout
        self._connect = connect or self._default_connect

    @staticmethod
    def load(path, **kwargs):
        try:
            fd = os.open(path, _open_flags(os.O_RDONLY))
        except OSError:
            raise AgentError("capability_invalid") from None
        with os.fdopen(fd, "rb") as handle:
            st = os.fstat(handle.fileno())
            if not stat.S_ISREG(st.st_mode):
                raise AgentError("capability_invalid")
            if os.name != "nt" and (st.st_mode & 0o077 or st.st_uid != os.getuid()):
                raise AgentError("capability_insecure")
            raw = handle.read(MAX_CAPABILITY_BYTES + 1)
        if len(raw) > MAX_CAPABILITY_BYTES:
            raise AgentError("capability_invalid")
        try:
            config = json.loads(raw.decode("utf-8"))
        except ValueError:
            raise AgentError("capability_invalid") from None
        return HttpBackend(config, **kwargs)

    def __repr__(self):
        return "HttpBackend(%s)" % self._host

    def _default_connect(self):
        if self._secure:
            return http.client.HTTPSConnection(self._host, self._port, timeout=self._timeout,
                                               context=ssl.create_default_context())
        return http.client.HTTPConnection(self._host, self._port, timeout=self._timeout)

    def _open(self, method, route, body=None, length=None, content_type=None):
        """Send one request; returns (connection, response) for a 2xx answer.  Raises BackendError for a
        definite server refusal (error envelope) and TransportUnknown for anything else."""
        if self._clock() * 1000 >= self.expires_at:
            raise BackendError("capability_expired")  # refused locally: nothing is sent
        headers = {"authorization": "Bearer " + self._token, "accept": "application/json",
                   "user-agent": "cloudbite-files-agent/1"}
        if body is not None:
            headers["content-type"] = content_type
            headers["content-length"] = str(length)
        conn = self._connect()
        try:
            conn.request(method, AGENT_PREFIX + "/" + route, body=body, headers=headers)
            resp = conn.getresponse()
        except (OSError, http.client.HTTPException, ssl.SSLError, socket.timeout):
            conn.close()
            raise TransportUnknown("connection") from None
        if 200 <= resp.status < 300:
            return conn, resp
        try:
            raw = resp.read(64 << 10) if resp.status >= 400 else b""
        except (OSError, http.client.HTTPException):
            raw = b""
        finally:
            conn.close()
        code = None
        with contextlib.suppress(ValueError, AttributeError, TypeError):
            code = json.loads(raw.decode("utf-8"))["error"]["code"]
        if 400 <= resp.status < 600 and isinstance(code, str) and code in BACKEND_CODES:
            raise BackendError(code)
        raise TransportUnknown("status_%d" % resp.status)  # redirects included: never followed

    def _json(self, method, route, payload=None):
        body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        conn, resp = self._open(method, route, body, None if body is None else len(body), "application/json")
        try:
            raw = resp.read(MAX_JSON_BYTES + 1)
        except (OSError, http.client.HTTPException):
            raise TransportUnknown("connection") from None
        finally:
            conn.close()
        try:
            value = json.loads(raw.decode("utf-8")) if len(raw) <= MAX_JSON_BYTES else None
        except ValueError:
            value = None
        if not isinstance(value, dict):
            raise TransportUnknown("malformed")
        return value

    @staticmethod
    def _q(value):
        return urllib.parse.quote(_ident(value), safe="")

    @staticmethod
    def _same_upload(up, req, upload_id=None):
        return (isinstance(up, dict) and isinstance(up.get("uploadId"), str) and bool(up["uploadId"])
                and (upload_id is None or up["uploadId"] == upload_id)
                and (req.get("fileId") is None or up.get("fileId") == req["fileId"])
                and up.get("baseVersion") == req["baseVersion"] and up.get("writerEpoch") == req["writerEpoch"]
                and up.get("size") == req["size"] and not isinstance(up.get("size"), bool)
                and up.get("sha256") == req["sha256"])

    def _receipt(self, req, result):
        """Canonical CommitResult + the op's staged immutable fields -> agent receipt."""
        if not isinstance(result, dict) or result.get("durable") is not True \
                or result.get("fileId") != req["fileId"] or result.get("size") != req["size"] \
                or isinstance(result.get("size"), bool) or result.get("sha256") != req["sha256"] \
                or not isinstance(result.get("versionId"), str) or not result["versionId"]:
            raise TransportUnknown("receipt_mismatch")
        if result.get("status") == "conflict":
            raise BackendError("base_version_conflict")
        if result.get("status") != "committed" or result["versionId"] == req["baseVersion"]:
            raise TransportUnknown("receipt_mismatch")
        return {"requestId": req["requestId"], "fileId": result["fileId"], "versionId": result["versionId"],
                "baseVersion": req["baseVersion"], "size": req["size"], "sha256": req["sha256"],
                "writerEpoch": req["writerEpoch"], "canonical": True}

    def fetch_version(self, req):
        # The server's descriptor must name exactly the registered version before any byte is requested.
        desc = self._json("POST", "open", {"fileId": req["fileId"], "versionId": req["versionId"]}).get("descriptor")
        if not isinstance(desc, dict) or desc.get("fileId") != req["fileId"] or isinstance(desc.get("size"), bool):
            raise TransportUnknown("malformed")
        if desc.get("versionId") != req["versionId"] or desc.get("size") != req["maxBytes"] \
                or desc.get("sha256") != req.get("sha256"):
            raise AgentError("version_mismatch")
        route = "content/%s?versionId=%s" % (self._q(req["fileId"]), self._q(req["versionId"]))
        conn, resp = self._open("GET", route)
        try:
            length = resp.getheader("content-length")
            declared = resp.getheader("x-cloudbite-sha256")
            version = resp.getheader("x-cloudbite-version")
            if length is not None and (not length.isdigit() or int(length) != req["maxBytes"]):
                raise AgentError("size_mismatch")
            if declared is not None and req.get("sha256") and declared.lower() != req["sha256"]:
                raise AgentError("checksum_mismatch")
            if version is not None and version != req["versionId"]:
                raise AgentError("version_mismatch")
            remaining = req["maxBytes"] + 1  # read one byte past the bound so overlong bodies are seen
            while remaining > 0:
                chunk = resp.read(min(CHUNK, remaining))
                if not chunk:
                    return
                remaining -= len(chunk)
                yield chunk
        finally:
            conn.close()

    def create_entry(self, req):
        entry = self._json("POST", "create", req).get("entry")
        if not isinstance(entry, dict) or entry.get("kind") != req["kind"] or entry.get("parentId") != req["parentId"] \
                or _nfc(entry.get("name")) != _nfc(req["name"]):
            raise TransportUnknown("receipt_mismatch")
        _ident(entry.get("fileId"))
        return entry

    def begin_upload(self, req):
        file_id = req["fileId"]
        if file_id is None:
            file_id = self.create_entry({"requestId": req["requestId"] + ":create", "parentId": req["parentId"],
                                         "name": req["name"], "kind": "file"})["fileId"]
        fields = {"requestId": req["requestId"], "fileId": file_id, "baseVersion": req["baseVersion"],
                  "writerEpoch": req["writerEpoch"], "size": req["size"], "sha256": req["sha256"]}
        up = self._json("POST", "uploads/begin", fields).get("upload")
        if not self._same_upload(up, fields):
            raise TransportUnknown("receipt_mismatch")
        _ident(up["uploadId"])
        return {"requestId": req["requestId"], "uploadId": up["uploadId"], "fileId": file_id, "phase": up.get("phase")}

    def put_body(self, req, handle):
        route = "uploads/%s/body" % self._q(req["uploadId"])
        conn, resp = self._open("PUT", route, handle, req["size"], "application/octet-stream")
        try:
            resp.read(MAX_JSON_BYTES)
        except (OSError, http.client.HTTPException):
            raise TransportUnknown("connection") from None
        finally:
            conn.close()

    def commit_upload(self, req):
        result = self._json("POST", "uploads/%s/commit" % self._q(req["uploadId"]),
                            {"uploadId": req["uploadId"]}).get("result")
        return self._receipt(req, result)

    def get_operation(self, req):
        rid = req["requestId"]
        if not req.get("uploadId"):
            return {"requestId": rid, "phase": "unknown_request"}  # begin reply lost: resend same requestId
        up = self._json("GET", "uploads/%s" % self._q(req["uploadId"])).get("upload")
        if not self._same_upload(up, req, req["uploadId"]):
            raise TransportUnknown("receipt_mismatch")
        phase = up.get("phase")
        if phase in ("committed", "conflict") and up.get("result") is not None:
            try:
                return {"requestId": rid, "phase": "committed", "receipt": self._receipt(req, up["result"])}
            except BackendError as err:
                return {"requestId": rid, "phase": "conflict", "code": err.code}
        if phase == "aborted":
            return {"requestId": rid, "phase": "rejected"}
        if phase in ("begun", "body_written"):
            expires = up.get("expiresAt")
            if isinstance(expires, (int, float)) and not isinstance(expires, bool) and expires <= self._clock() * 1000:
                return {"requestId": rid, "phase": "rejected"}  # expired reservation: a new op is needed
            return {"requestId": rid, "phase": "resend"}
        raise TransportUnknown("receipt_mismatch")

    def record_local_state(self, req):
        answer = self._json("POST", "local-state", req)
        local = answer.get("local")
        if not isinstance(answer.get("applied"), bool) or not isinstance(local, dict) \
                or local.get("fileId") != req["fileId"] or local.get("machineId") != req["machineId"] \
                or isinstance(local.get("seq"), bool) or not isinstance(local.get("seq"), int):
            raise TransportUnknown("malformed")
        return answer


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


def fold_ambiguous(path):
    """True when this agent's NFC+casefold key and the catalog's NFC+toLowerCase key may disagree
    (e.g. 'ß' vs 'ss', final sigma).  Such names are refused for registration and remote creation."""
    return any(_nfc(p).casefold() != _nfc(p).lower() for p in path.split("/"))


def _migrate(db):
    have = {r[1] for r in db.execute("PRAGMA table_info(ops)")}
    for column, kind in OPS_EXTRA:
        if column not in have:
            db.execute("ALTER TABLE ops ADD COLUMN %s %s" % (column, kind))


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
        _migrate(self.db)
        self.cfg = {r["key"]: json.loads(r["value"]) for r in self.db.execute("SELECT * FROM meta")}
        if "root" not in self.cfg:
            self.db.close()
            raise AgentError("not_configured")
        scope = getattr(self.backend, "scope", None)
        if scope is not None and any(scope.get(k) != self.cfg.get(k) for k in ("machineId", "workspaceId", "writerEpoch")):
            self.db.close()
            raise AgentError("scope_mismatch")  # capability for another machine/workspace/epoch: no request sent
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
        os.makedirs(os.path.join(state, "staging"), mode=0o700, exist_ok=True)
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
            _migrate(db)
            existing = db.execute("SELECT value FROM meta WHERE key='root'").fetchone()
            if existing and json.loads(existing[0]) != root:
                raise AgentError("invalid_argument")
            for key in ("workspaceId", "machineId"):
                prior = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
                if existing and prior and json.loads(prior[0]) != cfg[key]:
                    raise AgentError("invalid_argument")  # one journal per workspace+machine
            epoch = db.execute("SELECT value FROM meta WHERE key='writerEpoch'").fetchone()
            if existing and epoch and json.loads(epoch[0]) > cfg["writerEpoch"]:
                raise AgentError("stale_writer_epoch")  # never move the fence backwards
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
                if entry.get("kind") == "dir":
                    added += self._register_dir(db, _ident(entry.get("fileId")), entry.get("path"))
                    continue
                if entry.get("kind", "file") != "file":
                    raise AgentError("invalid_argument")
                file_id, path = _ident(entry.get("fileId")), entry.get("path")
                check_rel(path)
                if fold_ambiguous(path):
                    raise AgentError("path_ambiguous")
                if db.execute("SELECT 1 FROM dirs WHERE path_key=?", (path_key(path),)).fetchone():
                    raise AgentError("path_collision")
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

    def _register_dir(self, db, dir_id, path):
        """Record a catalog directory id for a path.  Metadata only: creates nothing on disk."""
        check_rel(path)
        if fold_ambiguous(path):
            raise AgentError("path_ambiguous")
        key = path_key(path)
        if db.execute("SELECT 1 FROM files WHERE path_key=?", (key,)).fetchone():
            raise AgentError("path_collision")
        same_id = db.execute("SELECT * FROM dirs WHERE dir_id=?", (dir_id,)).fetchone()
        same_key = db.execute("SELECT * FROM dirs WHERE path_key=?", (key,)).fetchone()
        if same_key and same_key["dir_id"] != dir_id:
            raise AgentError("path_collision")
        if same_id and same_id["path"] != path:
            raise AgentError("busy")  # directory moves are out of scope here
        if same_id:
            return 0
        db.execute("INSERT INTO dirs VALUES(?,?,?)", (dir_id, path, key))
        return 1

    def _parent(self, path):
        """(parentId, name) for a new remote entry; the parent must be a registered catalog directory."""
        if fold_ambiguous(path):
            raise AgentError("path_ambiguous")
        head, _, name = path.rpartition("/")
        if not head:
            return "root", name
        row = self.db.execute("SELECT dir_id, path FROM dirs WHERE path_key=?", (path_key(head),)).fetchone()
        if not row:
            raise AgentError("parent_not_registered")
        if row["path"] != head:
            raise AgentError("path_collision")
        return row["dir_id"], name

    def create_dir(self, path):
        """Create one remote directory under a registered parent.  The request id is journaled before
        sending, so a retry after an unknown outcome replays the same request, never a second folder."""
        check_rel(path)
        key = path_key(path)
        if self.db.execute("SELECT 1 FROM files WHERE path_key=?", (key,)).fetchone():
            raise AgentError("path_collision")
        done = self.db.execute("SELECT * FROM dirs WHERE path_key=?", (key,)).fetchone()
        if done:
            if done["path"] != path:
                raise AgentError("path_collision")
            return {"path": path, "dirId": done["dir_id"], "created": False}
        pending = self.db.execute("SELECT * FROM dir_ops WHERE path_key=?", (key,)).fetchone()
        if pending and pending["path"] != path:
            raise AgentError("path_collision")
        if not pending:
            parent_id, name = self._parent(path)
            with self._tx() as db:
                db.execute("INSERT INTO dir_ops VALUES(?,?,?,?,?)", (key, path, uuid.uuid4().hex, parent_id, name))
            pending = self.db.execute("SELECT * FROM dir_ops WHERE path_key=?", (key,)).fetchone()
        try:
            entry = self.backend.create_entry({"requestId": pending["request_id"], "parentId": pending["parent_id"],
                                               "name": pending["name"], "kind": "dir"})
        except BackendError as err:
            if err.code in ("request_conflict", "name_conflict"):
                with self._tx() as db:
                    db.execute("DELETE FROM dir_ops WHERE path_key=?", (key,))
            raise
        except Exception:
            raise AgentError("backend_error") from None  # unknown: same request id next time
        with self._tx() as db:
            self._register_dir(db, _ident(entry.get("fileId")), path)
            db.execute("DELETE FROM dir_ops WHERE path_key=?", (key,))
        return {"path": path, "dirId": entry["fileId"], "created": True}

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
        return self._eviction_verified() and r["origin"] == "agent" and r["state"] == "clean"             and not r["pinned"] and not r["open_count"]

    def _eviction_verified(self):
        """Only a backend that explicitly declares a verified eviction policy may remove local copies."""
        return getattr(self.backend, "eviction_policy", None) == "verified"

    # ---- open / materialize --------------------------------------------------------------------
    def open(self, path=None, file_id=None, version=None, lease_id=None):
        """``lease_id`` (32 lowercase hex, derived from the caller's request id) makes a retried open idempotent: the
        same id on the same file returns the existing lease instead of taking a second one that nobody would close."""
        if lease_id is not None and not (isinstance(lease_id, str) and re.fullmatch(r"[0-9a-f]{32}", lease_id)):
            raise AgentError("invalid_argument")
        row = self._row(path, file_id)
        if lease_id is not None:
            held = self.db.execute("SELECT row FROM leases WHERE lease_id=?", (lease_id,)).fetchone()
            if held:
                if held["row"] != row["id"]:
                    raise AgentError("request_conflict")
                return {"leaseId": lease_id, "path": row["path"], "state": row["state"],
                        "versionId": row["base_version"], "fetchedBytes": 0, "replayed": True}
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
        lease = lease_id or uuid.uuid4().hex
        with self._tx() as db:
            db.execute("INSERT OR IGNORE INTO leases VALUES(?,?,?)", (lease, row["id"], self.clock()))
            if db.execute("SELECT row FROM leases WHERE lease_id=?", (lease,)).fetchone()[0] != row["id"]:
                raise AgentError("request_conflict")  # a concurrent open used this id for another file
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
                                                         "maxBytes": size, "sha256": row["remote_sha"]})
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
        fresh = self.db.execute("SELECT id, path FROM files WHERE state='dirty' AND active_op IS NULL "
                                "ORDER BY id LIMIT ?", (limit,)).fetchall()
        for item in retry:
            results.append(self._send(item["request_id"]))
        for item in fresh[:max(0, limit - len(retry))]:
            try:
                request_id = self._prepare(item["id"])
            except AgentError as err:
                results.append({"path": item["path"], "code": err.code})
                continue
            except OSError:
                results.append({"path": item["path"], "code": "io_error"})
                continue
            if request_id:
                results.append(self._send(request_id))
        return {"results": results}

    def _prepare(self, row_id):
        """Stage an immutable snapshot and persist the operation before anything is sent."""
        row = self.db.execute("SELECT * FROM files WHERE id=?", (row_id,)).fetchone()
        parent_id, name = (None, None) if row["file_id"] else self._parent(row["path"])
        source = self._resolve(row["path"])
        st = os.stat(source)
        limit = self.cfg["maxTransferBytes"]
        if st.st_size > limit:
            raise AgentError("transfer_too_large")
        self._ensure_space(st.st_size)
        request_id = uuid.uuid4().hex
        part = os.path.join(self.staging, "upload-%s.part" % request_id)
        digest, size = hashlib.sha256(), 0
        try:
            fd = os.open(source, _open_flags(os.O_RDONLY))
            with os.fdopen(fd, "rb") as src, open(part, "xb") as out:
                # The file may still be growing: bound the snapshot and the reserve per chunk, not by the first stat.
                for chunk in iter(lambda: src.read(min(CHUNK, limit + 1 - size)), b""):
                    size += len(chunk)
                    if size > limit:
                        raise AgentError("transfer_too_large")
                    if self.disk_free(self.root) - len(chunk) < self.cfg["reserveBytes"]:
                        raise AgentError("insufficient_space")
                    digest.update(chunk)
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
            if current["file_id"] != row["file_id"]:
                self._unlink_staging("upload-" + request_id)
                return None
            db.execute("INSERT INTO ops(request_id,row,file_id,path,base_version,writer_epoch,size,sha256,dirty_rev,"
                       "phase,upload_id,receipt,code,created,parent_id,name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (request_id, row_id, current["file_id"], None if current["file_id"] else current["path"],
                        current["base_version"], self.cfg["writerEpoch"], size, digest.hexdigest(),
                        current["dirty_rev"], "prepared", None, None, None, self.clock(), parent_id, name))
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
                "parentId": op["parent_id"], "name": op["name"],
                "baseVersion": op["base_version"], "writerEpoch": op["writer_epoch"],
                "size": op["size"], "sha256": op["sha256"]})
            if not isinstance(began, dict) or began.get("requestId") != request_id or not began.get("uploadId") \
                    or (op["file_id"] is not None and began.get("fileId", op["file_id"]) != op["file_id"]):
                return self._mark_op(request_id, "unknown", "receipt_mismatch")
            upload_id = _ident(str(began["uploadId"]))
            file_id = op["file_id"] or (_ident(began["fileId"]) if began.get("fileId") is not None else None)
            with self._tx() as db:  # learned ids are journaled before any body byte is sent
                db.execute("UPDATE ops SET upload_id=?, file_id=? WHERE request_id=?", (upload_id, file_id, request_id))
            op = self._op(request_id)
            if began.get("phase") not in ("committed", "conflict"):  # replayed begin after commit: skip body
                with open(staged, "rb") as body:
                    self.backend.put_body({"uploadId": upload_id, "size": op["size"], "sha256": op["sha256"]}, body)
            receipt = self.backend.commit_upload(self._op_request(op))
        except BackendError as err:
            return self._rejected(request_id, err.code)
        except Exception:
            return self._mark_op(request_id, "unknown", "backend_error")
        return self._apply_receipt(request_id, receipt)

    @staticmethod
    def _op_request(op):
        return {"requestId": op["request_id"], "uploadId": op["upload_id"], "fileId": op["file_id"],
                "baseVersion": op["base_version"], "writerEpoch": op["writer_epoch"], "size": op["size"],
                "sha256": op["sha256"]}

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
                answer = self.backend.get_operation(self._op_request(self._op(request_id)))
            except BackendError as err:
                results.append({"requestId": request_id, "phase": "unknown", "code": err.code})
                continue
            except Exception:
                results.append({"requestId": request_id, "phase": "unknown", "code": "backend_error"})
                continue
            phase = answer.get("phase") if isinstance(answer, dict) and answer.get("requestId") == request_id else None
            if phase == "committed":
                results.append(self._apply_receipt(request_id, answer.get("receipt")))
            elif phase in ("unknown_request", "resend"):
                # never landed, or landed without a commit: resend the same id (begin/create replay server-side)
                results.append(self._mark_op(request_id, "prepared", None))
            elif phase == "conflict":
                results.append(self._rejected(request_id, answer.get("code") or "base_version_conflict"))
            elif phase == "rejected":
                results.append(self._rejected(request_id, "request_conflict"))
            else:
                results.append({"requestId": request_id, "phase": "unknown", "code": "pending"})
        return {"results": results}

    def report_local(self, limit=SYNC_LIMIT):
        """Report each catalog file's local copy (recordLocalState).  A clean claim is sent only for the
        verified catalog version; the seq is journaled before sending and only grows, so a late report
        can never overwrite a newer one on the server.  Unacknowledged reports are resent next time."""
        limit = min(_int(limit, 1), SYNC_LIMIT)
        rows = self.db.execute(
            "SELECT f.file_id, f.state, f.base_version, f.remote_version, r.seq, r.version, r.dirty AS rdirty, r.acked "
            "FROM files f LEFT JOIN reports r ON r.file_id=f.file_id "
            "WHERE f.file_id IS NOT NULL AND f.state!='remote-only' ORDER BY f.id").fetchall()
        results = []
        for row in rows:
            if len(results) >= limit:
                break
            dirty = row["state"] in ("dirty", "uploading", "conflict")
            version = row["base_version"]
            if not dirty and (version is None or version != row["remote_version"]):
                continue  # nothing verifiable to claim
            if row["acked"] and row["version"] == version and bool(row["rdirty"]) == dirty:
                continue
            seq = (row["seq"] or 0) + 1
            with self._tx() as db:
                db.execute("INSERT OR REPLACE INTO reports VALUES(?,?,?,?,0)", (row["file_id"], seq, version, int(dirty)))
            req = {"machineId": self.cfg["machineId"], "writerEpoch": self.cfg["writerEpoch"], "seq": seq,
                   "fileId": row["file_id"], "versionId": version, "dirty": dirty}
            try:
                answer = self.backend.record_local_state(req)
                local = answer["local"]
            except BackendError as err:
                results.append({"fileId": row["file_id"], "applied": False, "code": err.code})
                continue
            except Exception:
                results.append({"fileId": row["file_id"], "applied": False, "code": "backend_error"})
                continue
            acked = answer["applied"] or (local.get("versionId") == version and local.get("dirty") is dirty)
            with self._tx() as db:
                db.execute("UPDATE reports SET seq=MAX(seq, ?), acked=? WHERE file_id=?",
                           (local["seq"], int(bool(acked)), row["file_id"]))
            results.append({"fileId": row["file_id"], "applied": bool(answer["applied"]), "acked": bool(acked),
                            "dirty": dirty})
        return {"results": results}

    # ---- space -----------------------------------------------------------------------------------
    def _ensure_space(self, needed):
        shortfall = needed + self.cfg["reserveBytes"] - self.disk_free(self.root)
        if shortfall > 0 and self.cfg.get("autoEvict") and self._eviction_verified():
            self.evict(shortfall)
            shortfall = needed + self.cfg["reserveBytes"] - self.disk_free(self.root)
        if shortfall > 0:
            raise AgentError("insufficient_space")

    def evict(self, need_bytes=None):
        """Remove verified clean agent-created cache, least recently used first."""
        if not self._eviction_verified():
            raise AgentError("eviction_gated")  # no override: the backend must declare the verified policy
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
                "autoEvict": bool(self.cfg.get("autoEvict")),
                "eviction": "verified" if self._eviction_verified() else "gated"}

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
    parser.add_argument("--capability", help="private 0600 capability file for the HTTPS transport")
    sub = parser.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init", help="configure the single allowlisted workspace root")
    init.add_argument("--root", required=True)
    init.add_argument("--workspace-id", required=True)
    init.add_argument("--machine-id", required=True)
    init.add_argument("--writer-epoch", type=int, default=1)
    init.add_argument("--reserve-bytes", type=int, default=DEFAULT_RESERVE)
    init.add_argument("--max-transfer-bytes", type=int, default=DEFAULT_MAX_TRANSFER)
    init.add_argument("--auto-evict", action="store_true", help="evict clean agent cache under space pressure (only with a verified eviction policy)")
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
    opn.add_argument("--lease", help="32-hex lease id for an idempotent retry of the same open")
    cls = sub.add_parser("close", help="release an open lease")
    cls.add_argument("--lease", required=True)
    for name in ("pin", "unpin", "mark-dirty"):
        sub.add_parser(name).add_argument("--path", required=True)
    syn = sub.add_parser("sync", help="upload dirty files through the configured transport")
    syn.add_argument("--limit", type=int, default=SYNC_LIMIT)
    sub.add_parser("reconcile", help="resolve unknown upload outcomes by request id")
    rep = sub.add_parser("report-local", help="report local copy state of catalog files")
    rep.add_argument("--limit", type=int, default=SYNC_LIMIT)
    sub.add_parser("create-dir", help="create one remote folder under a registered parent").add_argument(
        "--path", required=True)
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
            if backend is None and args.capability:
                backend = HttpBackend.load(args.capability)
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
                    "open": lambda: agent.open(args.path, args.file_id, args.version, args.lease),
                    "close": lambda: agent.close_lease(args.lease),
                    "pin": lambda: agent.set_pinned(args.path, True),
                    "unpin": lambda: agent.set_pinned(args.path, False),
                    "mark-dirty": lambda: agent.mark_dirty(args.path),
                    "sync": lambda: agent.sync(args.limit),
                    "reconcile": lambda: agent.reconcile(),
                    "report-local": lambda: agent.report_local(args.limit),
                    "create-dir": lambda: agent.create_dir(args.path),
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
