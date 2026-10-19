#!/usr/bin/env python3
"""CloudBite files watcher: bounded polling of the managed workspace into the files agent's dirty journal.

Watches exactly one workspace root (default /home/daytona/CloudFiles), which must equal the root the files
agent was initialized with.  Each tick lstat-walks at most ``--max-entries`` directory entries (resumable
queue persisted in SQLite under --state), never follows symlinks, never descends deeper than MAX_DEPTH and
never reads a file larger than the configured cap.  A file that changed (size, mtime, inode or ctime) and
then stayed unchanged for the debounce window is hashed; when the hash differs from the last one the agent
acknowledged, the watcher runs ``files-agent.py mark-dirty`` as a subprocess (no shell, no credentials in
argv; only the agent reads its capability file).  Sync/reconcile run on a bounded schedule with backoff and
pause honestly on credential, fencing or retry-budget failures; nothing retries forever.

The watcher never modifies, moves or deletes workspace files, never evicts cache and never starts a
machine.  Deletions and renames are recorded as pending in the watcher journal only: the agent has no
tombstone operation, so the canonical copy is kept and end readiness is blocked (deleteSupport=unsupported).
Credentials, browser profiles, symlinks and special files are "protected"; dependency/VCS/build caches and
editor temporaries are "excluded" unless allowlisted.  Both are outside managed scope and reported as such,
never as saved.  Names the agent cannot save (too large, too deep, invalid, ambiguous, colliding) are
"unsupported" and block readiness.  Output is JSON metadata only: never file contents, tokens or the
capability file.  Application RAM/unsaved editor buffers and disk snapshots are not covered.
"""
import argparse
import contextlib
import fnmatch
import hashlib
import json
import os
import signal
import sqlite3
import stat
import subprocess
import sys
import time
import unicodedata

DEFAULT_ROOT = "/home/daytona/CloudFiles"
MAX_TICK_ENTRIES = 1000
MAX_DEPTH = 32
MAX_FILE_BYTES = 32 << 20
MAX_DIR_CHILDREN = 5000
MAX_PATH_BYTES = 4096
MAX_NAME_BYTES = 255
DEFAULT_MARKS = 50
MAX_MARKS = 200
HASH_BUDGET = 256 << 20
DEFAULT_DEBOUNCE = 2.0
RACY_NS = 2 * 10 ** 9
MIN_INTERVAL = 2.0
MAX_RUNTIME = 6 * 3600
MAX_END_TIMEOUT = 30.0
END_MAX_ENTRIES = 100000
SYNC_PERIOD = 60.0
SYNC_LIMIT = 20
MAX_CREATE_DIRS = 10
MAX_FAILURES = 8
BACKOFF_CAP = 900.0
AGENT_TIMEOUT = 120.0
MAX_AGENT_OUTPUT = 8 << 20
SAMPLES = 10
CHUNK = 1 << 20
REPARSE_POINT = 0x400
CONFIG_SCHEMA = "cloudbite.files.watch-config.v1"

# Mirrors files-agent.py check_rel: the agent refuses these, so they never enter managed scope.
FORBIDDEN_ANY = {".ssh", ".gnupg", ".aws", ".netrc", ".git-credentials"}
FORBIDDEN_TOP = {".config", ".local", ".mozilla", ".pki", ".cache"}
CREDENTIAL_NAMES = {".env", ".npmrc", ".pypirc", ".pgpass", ".docker", ".kube", ".azure", ".password-store",
                    "credentials.json", ".htpasswd"}
CREDENTIAL_GLOBS = (".env.*", "id_rsa*", "id_dsa*", "id_ecdsa*", "id_ed25519*", "*.pem", "*.key", "*.p12", "*.pfx",
                    "*.kdbx", "*.keystore", "*.jks")
PROFILE_DIRS = {".mozilla", ".thunderbird", "google-chrome", "chromium", "bravesoftware", ".pki", ".keyrings"}
PROFILE_MARKERS = {"login data", "key4.db", "logins.json", "cookies.sqlite", "local state"}
EXCLUDED_DIRS = {"node_modules": "dependencies", ".venv": "dependencies", ".git": "vcs", ".hg": "vcs", ".svn": "vcs",
                 "__pycache__": "build_cache", ".mypy_cache": "build_cache", ".pytest_cache": "build_cache",
                 ".ruff_cache": "build_cache", ".tox": "build_cache", ".gradle": "build_cache", ".next": "build_cache",
                 ".nuxt": "build_cache", ".parcel-cache": "build_cache", ".turbo": "build_cache",
                 ".cache": "build_cache", ".npm": "build_cache"}
TRANSIENT_GLOBS = (".goutputstream-*", "*.swp", "*.swx", "*.swo", ".~lock.*#", "*.crdownload", "*.part", "~$*")

PAUSE_CODES = {"capability_expired": "credential_expired", "capability_invalid": "credential_invalid",
               "capability_insecure": "credential_invalid", "scope_mismatch": "credential_invalid",
               "stale_writer": "writer_fenced", "stale_writer_epoch": "writer_fenced", "not_running": "not_running",
               "transport_not_configured": "transport_not_configured", "quota_exceeded": "quota_exceeded",
               "not_configured": "agent_not_configured"}
TRANSIENT_CODES = {"backend_error", "catalog_busy", "catalog_unavailable", "blob_unavailable", "not_durable", "busy",
                   "io_error", "agent_failed", "agent_timeout", "commit_unknown", "too_many_uploads",
                   "insufficient_space"}
PERMANENT_MARK_CODES = {"path_collision", "path_invalid", "path_forbidden", "path_symlink", "path_ambiguous",
                        "invalid_argument"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entries(
  path TEXT PRIMARY KEY, akey TEXT NOT NULL UNIQUE, size INTEGER, mtime_ns INTEGER, ino INTEGER, ctime_ns INTEGER,
  seen_gen INTEGER NOT NULL, changed_at REAL NOT NULL, sha TEXT, marked_sha TEXT, known INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 1, racy INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, code TEXT);
CREATE INDEX IF NOT EXISTS entries_pending ON entries(pending, changed_at);
CREATE INDEX IF NOT EXISTS entries_gen ON entries(seen_gen);
CREATE TABLE IF NOT EXISTS skipped(path TEXT PRIMARY KEY, category TEXT NOT NULL, reason TEXT NOT NULL,
  gen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS deletions(path TEXT PRIMARY KEY, reason TEXT NOT NULL, detected REAL NOT NULL);
CREATE TABLE IF NOT EXISTS queue(id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, depth INTEGER NOT NULL,
  after TEXT);
"""


class WatchError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def path_key(path):
    """The agent's collision key (files-agent.py path_key)."""
    return unicodedata.normalize("NFC", path).casefold()


def _is_link(st):
    return stat.S_ISLNK(st.st_mode) or bool(getattr(st, "st_file_attributes", 0) & REPARSE_POINT)


def _sig(st):
    return (st.st_size, st.st_mtime_ns, st.st_ino, st.st_ctime_ns)


def _within(child, parent):
    try:
        return os.path.commonpath([child, parent]) == parent
    except ValueError:  # different drives
        return False


def _same_path(a, b):
    return os.path.normcase(a) == os.path.normcase(b)


def display(name):
    """A printable form of an undecodable (surrogate-escaped) name."""
    return os.fsencode(name).decode("utf-8", "backslashreplace")


def name_problem(name):
    """Why the agent could not save a file or folder with this name, or None."""
    try:
        raw = name.encode("utf-8")
    except UnicodeEncodeError:
        return "name_undecodable"
    if len(raw) > MAX_NAME_BYTES or "\\" in name or any(ord(c) < 32 or ord(c) == 127 for c in name):
        return "name_invalid"
    nfc = unicodedata.normalize("NFC", name)
    if nfc.casefold() != nfc.lower():
        return "name_ambiguous"
    return None


def classify_name(name, top, is_dir, allow):
    """(category, reason) for a name that leaves managed scope, or None."""
    folded = name.casefold()
    if folded in FORBIDDEN_ANY or (top and folded in FORBIDDEN_TOP) or folded in CREDENTIAL_NAMES \
            or any(fnmatch.fnmatchcase(folded, g) for g in CREDENTIAL_GLOBS):
        return "protected", "credential"
    if is_dir and folded in PROFILE_DIRS:
        return "protected", "profile"
    if is_dir and folded in EXCLUDED_DIRS and folded not in allow:
        return "excluded", EXCLUDED_DIRS[folded]
    if not is_dir and any(fnmatch.fnmatchcase(folded, g) for g in TRANSIENT_GLOBS):
        return "excluded", "transient"
    return None


class Lock:
    """One watcher writer per state directory; held for the life of the process (released on exit)."""

    def __init__(self, path):
        self.fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        self.held = False

    def try_acquire(self):
        try:
            if os.name == "nt":
                import msvcrt
                os.lseek(self.fd, 0, os.SEEK_SET)
                msvcrt.locking(self.fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return False
        self.held = True
        return True

    def acquire(self, deadline, clock=time.monotonic):
        while not self.try_acquire():
            if clock() >= deadline:
                return False
            time.sleep(0.1)
        return True

    def close(self):
        if self.held and os.name == "nt":
            import msvcrt
            with contextlib.suppress(OSError):
                os.lseek(self.fd, 0, os.SEEK_SET)
                msvcrt.locking(self.fd, msvcrt.LK_UNLCK, 1)
        os.close(self.fd)
        self.held = False


class SubprocessAgent:
    """Runs files-agent.py with an isolated interpreter, an argv list and a minimal environment."""

    ENV_KEYS = ("PATH", "HOME", "LANG", "LC_ALL", "SYSTEMROOT", "TMPDIR", "TEMP", "TMP")

    def __init__(self, agent, agent_state, capability=None, python=None):
        self.argv = [python or sys.executable, "-I", "-B", agent, "--state", agent_state]
        if capability:
            self.argv += ["--capability", capability]
        self.env = {k: os.environ[k] for k in self.ENV_KEYS if k in os.environ}
        self.env.update(PYTHONIOENCODING="utf-8", PYTHONDONTWRITEBYTECODE="1")

    def __call__(self, args, timeout=AGENT_TIMEOUT):
        if timeout is not None and timeout <= 0:
            return {"ok": False, "code": "agent_timeout"}
        try:
            proc = subprocess.run(self.argv + list(args), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, timeout=timeout, env=self.env, shell=False)
        except subprocess.TimeoutExpired:
            return {"ok": False, "code": "agent_timeout"}
        except OSError:
            return {"ok": False, "code": "agent_failed"}
        out = proc.stdout
        if proc.returncode not in (0, 2) or len(out) > MAX_AGENT_OUTPUT:
            return {"ok": False, "code": "agent_failed"}  # e.g. an uncaught 'database is locked': retry later
        try:
            value = json.loads(out.decode("utf-8").strip().splitlines()[-1])
        except (ValueError, IndexError, UnicodeDecodeError):
            return {"ok": False, "code": "agent_failed"}
        if not isinstance(value, dict) or not isinstance(value.get("ok"), bool):
            return {"ok": False, "code": "agent_failed"}
        if not value["ok"] and not isinstance(value.get("code"), str):
            value["code"] = "agent_failed"
        return value


def _bounded(value, low, high, code="invalid_argument"):
    if value is None or not (low <= value <= high):
        raise WatchError(code)
    return value


class Watcher:
    def __init__(self, state_dir, root, agent, clock=time.time, monotonic=time.monotonic, allow=(),
                 max_file_bytes=MAX_FILE_BYTES):
        self.state_dir = state_dir
        self.root = root
        self.agent = agent
        self.clock = clock
        self.monotonic = monotonic
        self.allow = {a.casefold() for a in allow}
        self.max_file_bytes = max_file_bytes
        self.db = sqlite3.connect(os.path.join(state_dir, "watch.sqlite3"), isolation_level=None, timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript(SCHEMA)
        self.marks = 0
        self.interrupted = lambda: False

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

    def get(self, key, default=None):
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def put(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO meta VALUES(?,?)", (key, json.dumps(value)))

    def _abs(self, rel):
        return os.path.join(self.root, *rel.split("/")) if rel else self.root

    # ---- scanning --------------------------------------------------------------------------------
    def scanning(self):
        return self.db.execute("SELECT 1 FROM queue LIMIT 1").fetchone() is not None

    def start_generation(self):
        """Begin a fresh full pass; a partially walked earlier pass is abandoned (its rows are re-seen)."""
        with self._tx() as db:
            gen = self.get("gen", 0) + 1
            db.execute("DELETE FROM queue")
            db.execute("INSERT INTO queue(path, depth, after) VALUES('', 0, NULL)")
            self.put("gen", gen)
            self.put("genStarted", self.clock())
        return gen

    def scan_step(self, budget, deadline=None):
        """Process up to ``budget`` directory entries.  Returns (processed, completed_generation)."""
        if not self.scanning() and self.get("lastCompleteGen") == self.get("gen"):
            self.start_generation()  # (a walked pass whose deletion check was cut short is finished first)
        gen = self.get("gen")
        processed = 0
        while processed < budget:
            item = self.db.execute("SELECT * FROM queue ORDER BY id LIMIT 1").fetchone()
            if item is None:
                break
            processed += self._scan_dir(item, gen, budget - processed)
        if self.scanning():
            return processed, False
        return processed, self.finish_generation(gen, deadline)

    def _skip(self, db, rel, category, reason, gen):
        db.execute("INSERT OR REPLACE INTO skipped VALUES(?,?,?,?)", (rel, category, reason, gen))

    def _scan_dir(self, item, gen, budget):
        rel, depth = item["path"], item["depth"]
        path = self._abs(rel)
        names = []
        try:
            st = os.lstat(path)
            if _is_link(st) or not stat.S_ISDIR(st.st_mode):
                with self._tx() as db:  # replaced since it was queued: the parent pass classifies it next time
                    db.execute("DELETE FROM queue WHERE id=?", (item["id"],))
                return 1
            with os.scandir(path) as it:
                for entry in it:
                    names.append(entry.name)
                    if len(names) > MAX_DIR_CHILDREN:
                        break
        except FileNotFoundError:
            with self._tx() as db:
                db.execute("DELETE FROM queue WHERE id=?", (item["id"],))
            return 1
        except OSError:
            with self._tx() as db:
                self._skip(db, rel or ".", "unsupported", "unreadable_dir", gen)
                db.execute("DELETE FROM queue WHERE id=?", (item["id"],))
            return 1
        if len(names) > MAX_DIR_CHILDREN:
            with self._tx() as db:
                self._skip(db, rel or ".", "unsupported", "too_many_children", gen)
                db.execute("DELETE FROM queue WHERE id=?", (item["id"],))
            return 1
        if rel and any(n.casefold() in PROFILE_MARKERS for n in names):
            with self._tx() as db:
                self._skip(db, rel, "protected", "profile", gen)
                db.execute("DELETE FROM queue WHERE id=?", (item["id"],))
            return 1
        # Resume after the last processed name (bytes order), so entries added or removed meanwhile shift nothing.
        keyed = sorted((os.fsencode(n), n) for n in names)
        after = bytes.fromhex(item["after"]) if item["after"] else None
        todo = [(k, n) for k, n in keyed if after is None or k > after][:budget]
        with self._tx() as db:
            for key, name in todo:
                self._scan_entry(db, rel, name, depth + 1, gen)
            if len(todo) < budget or (todo and todo[-1][0] == keyed[-1][0]) or not keyed:
                db.execute("DELETE FROM queue WHERE id=?", (item["id"],))
            else:
                db.execute("UPDATE queue SET after=? WHERE id=?", (todo[-1][0].hex(), item["id"]))
        return max(1, len(todo))

    def _scan_entry(self, db, parent, name, depth, gen):
        rel = parent + "/" + name if parent else name
        problem = name_problem(name)
        if problem == "name_undecodable":
            self._skip(db, (parent + "/" if parent else "") + display(name), "unsupported", problem, gen)
            return
        try:
            st = os.lstat(self._abs(rel))
        except OSError:
            return  # vanished between listing and lstat: the next pass sees the outcome
        is_dir = stat.S_ISDIR(st.st_mode) and not _is_link(st)
        scope = classify_name(name, not parent, is_dir, self.allow)
        if scope:
            self._skip(db, rel, scope[0], scope[1], gen)
        elif _is_link(st):
            self._skip(db, rel, "protected", "symlink", gen)
        elif problem:
            self._skip(db, rel, "unsupported", problem, gen)
        elif len(rel.encode("utf-8")) > MAX_PATH_BYTES:
            self._skip(db, rel, "unsupported", "path_too_long", gen)
        elif is_dir:
            if depth < MAX_DEPTH:
                db.execute("INSERT INTO queue(path, depth, after) VALUES(?,?,NULL)", (rel, depth))
            elif self._nonempty(rel):
                self._skip(db, rel, "unsupported", "depth_exceeded", gen)
        elif not stat.S_ISREG(st.st_mode):
            self._skip(db, rel, "protected", "special_file", gen)
        elif st.st_size > self.max_file_bytes:
            self._skip(db, rel, "unsupported", "too_large", gen)
        else:
            self._observe(db, rel, st, gen)

    def _nonempty(self, rel):
        try:
            with os.scandir(self._abs(rel)) as it:
                return next(it, None) is not None
        except OSError:
            return True

    def _observe(self, db, rel, st, gen):
        now = self.clock()
        row = db.execute("SELECT * FROM entries WHERE path=?", (rel,)).fetchone()
        if row is None:
            akey = path_key(rel)
            if db.execute("SELECT 1 FROM entries WHERE akey=?", (akey,)).fetchone():
                self._skip(db, rel, "unsupported", "path_collision", gen)
                return
            known = db.execute("DELETE FROM deletions WHERE path=?", (rel,)).rowcount > 0  # re-created
            size, mtime, ino, ctime = _sig(st)
            db.execute("INSERT INTO entries(path, akey, size, mtime_ns, ino, ctime_ns, seen_gen, changed_at, known)"
                       " VALUES(?,?,?,?,?,?,?,?,?)", (rel, akey, size, mtime, ino, ctime, gen, now, int(known)))
            return
        if _sig(st) != (row["size"], row["mtime_ns"], row["ino"], row["ctime_ns"]):
            size, mtime, ino, ctime = _sig(st)
            db.execute("UPDATE entries SET size=?, mtime_ns=?, ino=?, ctime_ns=?, seen_gen=?, changed_at=?, pending=1,"
                       " attempts=0, code=NULL WHERE path=?", (size, mtime, ino, ctime, gen, now, rel))
        elif row["racy"] and row["pending"] == 0:
            db.execute("UPDATE entries SET seen_gen=?, pending=1 WHERE path=?", (gen, rel))
        else:
            db.execute("UPDATE entries SET seen_gen=? WHERE path=?", (gen, rel))

    def finish_generation(self, gen, deadline=None):
        """Entries not seen in a complete pass left managed scope: pending deletion when the agent knew them.
        Returns False when the deadline cut it short (the next scan_step continues it)."""
        now = self.clock()
        while True:
            if deadline is not None and self.monotonic() >= deadline:
                return False
            rows = self.db.execute("SELECT path, known FROM entries WHERE seen_gen<? LIMIT 500", (gen,)).fetchall()
            if not rows:
                break
            with self._tx() as db:
                for row in rows:
                    if row["known"]:
                        try:
                            os.lstat(self._abs(row["path"]))
                            reason = "left_scope"
                        except OSError:
                            reason = "deleted"
                        db.execute("INSERT OR IGNORE INTO deletions VALUES(?,?,?)", (row["path"], reason, now))
                    db.execute("DELETE FROM entries WHERE path=?", (row["path"],))
        with self._tx() as db:
            db.execute("DELETE FROM skipped WHERE gen<?", (gen,))
            self.put("lastCompleteGen", gen)
            self.put("lastCompleteAt", now)
        return True

    # ---- marking ---------------------------------------------------------------------------------
    def mark_pending(self, debounce, max_marks, deadline=None):
        """Hash stable changed files and hand real content changes to the agent.  Returns marks sent."""
        now = self.clock()
        rows = self.db.execute("SELECT * FROM entries WHERE pending=1 AND changed_at<=? ORDER BY changed_at, path"
                               " LIMIT ?", (now - debounce, max_marks)).fetchall()
        budget, sent = HASH_BUDGET, 0
        for row in rows:
            if budget <= 0 or self.interrupted() or (deadline is not None and self.monotonic() >= deadline):
                break
            result = self._hash_stable(row, deadline)
            if result is None:
                continue
            digest, size = result
            budget -= size
            racy = int(time.time_ns() - row["mtime_ns"] < RACY_NS)
            if digest == row["marked_sha"]:
                with self._tx() as db:
                    db.execute("UPDATE entries SET sha=?, pending=0, racy=?, code=NULL WHERE path=?",
                               (digest, racy, row["path"]))
                continue
            timeout = AGENT_TIMEOUT if deadline is None else min(AGENT_TIMEOUT, deadline - self.monotonic())
            answer = self.agent(["mark-dirty", "--path=" + row["path"]], timeout=timeout)
            sent += 1
            with self._tx() as db:
                if answer.get("ok"):
                    db.execute("UPDATE entries SET sha=?, marked_sha=?, known=1, pending=0, racy=?, attempts=0,"
                               " code=NULL WHERE path=?", (digest, digest, racy, row["path"]))
                    continue
                code = answer.get("code")
                if code in PERMANENT_MARK_CODES:
                    db.execute("UPDATE entries SET pending=2, code=? WHERE path=?", (code, row["path"]))
                else:
                    db.execute("UPDATE entries SET attempts=attempts+1, code=? WHERE path=?", (code, row["path"]))
        self.marks += sent
        return sent

    def _hash_stable(self, row, deadline=None):
        """(sha256, size) when the file still has the recorded signature before and after hashing."""
        rel = row["path"]
        path = self._abs(rel)
        recorded = (row["size"], row["mtime_ns"], row["ino"], row["ctime_ns"])
        try:
            fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
        except OSError:
            return None  # vanished or replaced by a symlink: the next complete pass classifies it
        with os.fdopen(fd, "rb") as handle:
            st = os.fstat(handle.fileno())
            if not stat.S_ISREG(st.st_mode) or st.st_size > self.max_file_bytes:
                return None
            digest, size = hashlib.sha256(), 0
            for chunk in iter(lambda: handle.read(CHUNK), b""):
                size += len(chunk)
                if size > self.max_file_bytes or (deadline is not None and self.monotonic() >= deadline):
                    return None
                digest.update(chunk)
        try:
            after = os.lstat(path)
        except OSError:
            return None
        current = _sig(after)
        if current != recorded or size != after.st_size or _is_link(after):
            with self._tx() as db:  # still being written or replaced: restart its debounce window
                db.execute("UPDATE entries SET size=?, mtime_ns=?, ino=?, ctime_ns=?, changed_at=? WHERE path=?",
                           current + (self.clock(), rel))
            return None
        return digest.hexdigest(), size

    # ---- sync ------------------------------------------------------------------------------------
    def sync_due(self, force=False):
        if self.get("pause") or self.clock() < self.get("backoffUntil", 0):
            return False
        return force or self.marks > 0 or self.clock() - self.get("lastSyncAt", 0) >= SYNC_PERIOD

    def sync(self, interval):
        """One bounded reconcile+sync round through the agent; classifies failures into pause/backoff."""
        codes = []
        to_create = []
        for args in (["reconcile"], ["sync", "--limit", str(SYNC_LIMIT)]):
            answer = self.agent(args)
            if not answer.get("ok"):
                codes.append(answer.get("code"))
                break
            for result in answer.get("results") or []:
                code = result.get("code") if isinstance(result, dict) else None
                if code == "parent_not_registered" and isinstance(result.get("path"), str):
                    to_create.append(result["path"])
                elif code and code != "stale_ack":
                    codes.append(code)
        created = 0
        for path in to_create:
            parts = path.split("/")[:-1]
            for i in range(1, len(parts) + 1):
                if created >= MAX_CREATE_DIRS:
                    break
                answer = self.agent(["create-dir", "--path=" + "/".join(parts[:i])])
                created += 1
                if not answer.get("ok"):
                    codes.append(answer.get("code"))
                    break
        return self._classify(codes, interval, created)

    def _classify(self, codes, interval, created=0):
        now = self.clock()
        pause = next((PAUSE_CODES[c] for c in codes if c in PAUSE_CODES), None)
        transient = [c for c in codes if c in TRANSIENT_CODES]
        with self._tx():
            self.put("lastSyncAt", now)
            self.put("lastSyncCodes", sorted(set(c for c in codes if isinstance(c, str))))
            if pause:
                self.put("pause", pause)
            elif transient:
                failures = self.get("failures", 0) + 1
                self.put("failures", failures)
                self.put("backoffUntil", now + min(BACKOFF_CAP, interval * (2 ** failures)))
                if failures >= MAX_FAILURES:
                    self.put("pause", "retry_exhausted")
            else:
                self.put("failures", 0)
                self.put("backoffUntil", 0)
        self.marks = 0
        return {"codes": sorted(set(c for c in codes if isinstance(c, str))), "createdDirs": created,
                "pause": self.get("pause"), "failures": self.get("failures", 0)}

    # ---- reporting -------------------------------------------------------------------------------
    def scope_report(self):
        out = {}
        for category in ("excluded", "protected", "unsupported"):
            reasons = {r["reason"]: r["n"] for r in self.db.execute(
                "SELECT reason, COUNT(*) n FROM skipped WHERE category=? GROUP BY reason", (category,))}
            samples = [r["path"] for r in self.db.execute(
                "SELECT path FROM skipped WHERE category=? ORDER BY path LIMIT ?", (category, SAMPLES))]
            out[category] = {"count": sum(reasons.values()), "reasons": reasons, "samples": samples}
        failed = {r["code"]: r["n"] for r in self.db.execute(
            "SELECT code, COUNT(*) n FROM entries WHERE pending=2 GROUP BY code")}
        for code, n in failed.items():
            out["unsupported"]["reasons"]["agent_" + code] = n
            out["unsupported"]["count"] += n
        return out

    def counts(self):
        one = lambda sql, *a: self.db.execute(sql, a).fetchone()[0]
        return {"tracked": one("SELECT COUNT(*) FROM entries"),
                "pendingMarks": one("SELECT COUNT(*) FROM entries WHERE pending=1"),
                "markErrors": one("SELECT COUNT(*) FROM entries WHERE pending=1 AND code IS NOT NULL"),
                "pendingDeletions": one("SELECT COUNT(*) FROM deletions"),
                "deletionSamples": [r[0] for r in self.db.execute(
                    "SELECT path FROM deletions ORDER BY path LIMIT ?", (SAMPLES,))]}

    def status(self):
        return dict(self.counts(), scope=self.scope_report(), generation=self.get("gen", 0),
                    scanning=self.scanning(), lastCompleteGen=self.get("lastCompleteGen"),
                    lastCompleteAt=self.get("lastCompleteAt"), draining=bool(self.get("draining", False)),
                    pause=self.get("pause"), failures=self.get("failures", 0),
                    backoffUntil=self.get("backoffUntil", 0), lastSyncAt=self.get("lastSyncAt"),
                    lastSyncCodes=self.get("lastSyncCodes", []), deleteSupport="unsupported")


# ---- configuration --------------------------------------------------------------------------------
def _real_dir(path, code):
    path = os.path.abspath(path)
    try:
        st = os.lstat(path)
    except OSError:
        raise WatchError(code) from None
    if _is_link(st) or not stat.S_ISDIR(st.st_mode) or not _same_path(os.path.realpath(path), path):
        raise WatchError(code)
    return path


def _private_dir(path):
    path = os.path.abspath(path)
    if not os.path.lexists(path):
        os.makedirs(path, 0o700)
    path = _real_dir(path, "state_invalid")
    if os.name != "nt":
        st = os.stat(path)
        if st.st_uid != os.getuid() or st.st_mode & 0o077:
            raise WatchError("state_insecure")
    return path


def _agent_root(agent_state):
    """The root the files agent was initialized with (read-only look at its journal meta)."""
    journal = os.path.join(agent_state, "journal.sqlite3")
    if not os.path.isfile(journal):
        raise WatchError("agent_not_configured")
    try:
        db = sqlite3.connect(journal, timeout=10)
        try:
            db.execute("PRAGMA query_only=1")
            row = db.execute("SELECT value FROM meta WHERE key='root'").fetchone()
        finally:
            db.close()
    except sqlite3.Error:
        raise WatchError("agent_unavailable") from None
    if not row:
        raise WatchError("agent_not_configured")
    return json.loads(row[0])


def load_config(args):
    """Verify the root and agent and pin them in a private config; later invocations must match it."""
    state = _private_dir(args.state)
    root = _real_dir(args.root, "root_invalid")
    agent_state = _real_dir(args.agent_state, "agent_state_invalid")
    home = os.path.realpath(os.path.expanduser("~"))
    if os.path.dirname(root) == root or _within(home, root):
        raise WatchError("root_forbidden")  # never the filesystem root, HOME or anything containing HOME
    for other in (state, agent_state):
        if _within(other, root) or _within(root, other):
            raise WatchError("root_forbidden")
    if os.name != "nt":
        st = os.stat(root)
        if st.st_uid != os.getuid() or st.st_mode & 0o022:
            raise WatchError("root_insecure")
    try:
        agent_st = os.lstat(args.agent)
    except OSError:
        raise WatchError("agent_invalid") from None
    if _is_link(agent_st) or not stat.S_ISREG(agent_st.st_mode):
        raise WatchError("agent_invalid")
    agent_root = _agent_root(agent_state)
    if not isinstance(agent_root, str) or not _same_path(os.path.realpath(agent_root), root):
        raise WatchError("root_mismatch")
    max_file = _bounded(args.max_file_bytes, 1, MAX_FILE_BYTES)
    allow = sorted({a.casefold() for a in args.allow or []})
    if any(a not in EXCLUDED_DIRS for a in allow):
        raise WatchError("invalid_argument")  # only cache/VCS/dependency dirs can be opted in; never credentials
    config = {"schema": CONFIG_SCHEMA, "root": root, "agent": os.path.abspath(args.agent), "agentState": agent_state,
              "capability": os.path.abspath(args.capability) if args.capability else None, "allow": allow,
              "maxFileBytes": max_file}
    path = os.path.join(state, "config.json")
    try:
        with open(path, "rb") as handle:
            pinned = json.loads(handle.read(1 << 16).decode("utf-8"))
    except FileNotFoundError:
        pinned = None
    except ValueError:
        raise WatchError("config_invalid") from None
    if pinned is None:
        fd = os.open(path + ".next", os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(config, handle, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(path + ".next", path)
    elif pinned != config:
        raise WatchError("config_mismatch")  # the trusted config is fixed at first use
    return state, config


# ---- commands -------------------------------------------------------------------------------------
class Session:
    def __init__(self, args, runner=None):
        self.state, self.config = load_config(args)
        self.lock = Lock(os.path.join(self.state, "watch.lock"))
        self.runner = runner or SubprocessAgent(self.config["agent"], self.config["agentState"],
                                                self.config["capability"])
        self.watcher = Watcher(self.state, self.config["root"], self.runner, allow=self.config["allow"],
                               max_file_bytes=self.config["maxFileBytes"])
        self.drain_flag = os.path.join(self.state, "drain.request")
        self.resume_flag = os.path.join(self.state, "resume.request")

    def close(self):
        self.watcher.close()
        self.lock.close()

    def _flag(self, path):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        os.close(fd)

    def _unflag(self, path):
        with contextlib.suppress(FileNotFoundError):
            os.unlink(path)

    def _take(self):
        if not self.lock.try_acquire():
            raise WatchError("watcher_busy")
        if self.watcher.get("draining", False):
            raise WatchError("draining")

    def tick(self, max_entries, debounce, max_marks, interval, do_sync=True):
        w = self.watcher
        processed, completed = w.scan_step(max_entries)
        sent = w.mark_pending(debounce, max_marks)
        result = {"processed": processed, "completedGeneration": completed, "marked": sent}
        if do_sync and w.sync_due():
            result["sync"] = w.sync(interval)
        return result

    def scan_once(self, a):
        self._take()
        self._apply_resume_request()
        result = self.tick(_bounded(a.max_entries, 1, MAX_TICK_ENTRIES), _bounded(a.debounce, 0, 60),
                           _bounded(a.max_marks, 1, MAX_MARKS), MIN_INTERVAL, do_sync=a.sync)
        result["status"] = self.watcher.status()
        return result

    def run(self, a):
        interval = _bounded(a.interval, MIN_INTERVAL, 3600)
        runtime = _bounded(a.max_runtime, 1, MAX_RUNTIME)
        entries, debounce, marks = (_bounded(a.max_entries, 1, MAX_TICK_ENTRIES), _bounded(a.debounce, 0, 60),
                                    _bounded(a.max_marks, 1, MAX_MARKS))
        self._take()
        stop = []
        with contextlib.suppress(ValueError, AttributeError):
            signal.signal(signal.SIGTERM, lambda *_: stop.append("terminated"))
        self.watcher.interrupted = lambda: bool(stop) or os.path.exists(self.drain_flag)
        started = time.monotonic()
        ticks = 0
        reason = "max_runtime"
        while True:
            if os.path.exists(self.drain_flag):
                reason = "drain_requested"
                break
            self._apply_resume_request()
            self.tick(entries, debounce, marks, interval)
            ticks += 1
            wake = time.monotonic() + interval
            while time.monotonic() < wake and not stop and not os.path.exists(self.drain_flag):
                time.sleep(min(0.25, max(0.0, wake - time.monotonic())))
            if stop:
                reason = stop[0]
                break
            if time.monotonic() - started >= runtime:
                break
        return {"stopped": reason, "ticks": ticks, "status": self.watcher.status()}

    def _apply_resume_request(self):
        if os.path.exists(self.resume_flag):
            with self.watcher._tx():
                self.watcher.put("pause", None)
                self.watcher.put("failures", 0)
                self.watcher.put("backoffUntil", 0)
            self._unflag(self.resume_flag)

    def prepare_end(self, a):
        """Stop the watcher, finish a complete bounded pass, flush through the agent; conservative readiness.
        Total wall time (lock wait, scan, hashing, agent subprocess) stays within --timeout."""
        timeout = _bounded(a.timeout, 1, MAX_END_TIMEOUT)
        limit = _bounded(a.end_max_entries, 1, END_MAX_ENTRIES)
        started = time.monotonic()
        deadline = started + timeout
        scan_deadline = started + timeout * 0.6
        w = self.watcher
        blocking = []
        self._flag(self.drain_flag)  # a running watcher exits at its next check and releases the lock
        if not self.lock.acquire(min(deadline, started + 10)):
            return self._end_report(None, False, True, ["watcher_busy"], started)
        with w._tx():
            w.put("draining", True)
        self._unflag(self.drain_flag)
        w.start_generation()
        scanned, complete = 0, False
        while time.monotonic() < scan_deadline and scanned < limit:
            step, complete = w.scan_step(min(MAX_TICK_ENTRIES, limit - scanned), scan_deadline)
            scanned += step
            w.mark_pending(0, MAX_MARKS, scan_deadline)
            if complete:
                break
        if not complete:
            blocking.append("scan_limit" if scanned >= limit else "scan_timeout")
        while complete and time.monotonic() < scan_deadline and w.mark_pending(0, MAX_MARKS, scan_deadline):
            pass
        # Paused (credential/fencing/retry budget): report only, no further network attempt.
        args = ["prepare-end"] if w.get("pause") else ["prepare-end", "--flush"]
        remaining = deadline - time.monotonic() - 0.5  # leave room to kill the agent and build the report
        agent = self.runner(args, timeout=remaining) if remaining >= 1 else {"ok": False, "code": "agent_timeout"}
        return self._end_report(agent, complete, False, blocking, started)

    def _end_report(self, agent, complete, busy, blocking, started):
        w = self.watcher
        counts = w.counts()
        scope = w.scope_report()
        agent = agent or {"ok": False, "code": "not_invoked"}
        keys = ("dirty", "uploading", "conflict", "unconfirmedOps", "open")
        well_formed = agent.get("ok") is True and all(isinstance(agent.get(k), list) for k in keys + ("errors",)) \
            and isinstance(agent.get("ready"), bool) and isinstance(agent.get("remoteSaved"), bool)
        # Unknown agent counts are null, never 0 (computerDrainVerified treats non-numbers as not verified).
        lists = {k: agent[k] if well_formed else None for k in keys}
        agent_errors = agent["errors"] if well_formed else []
        agent_ready = well_formed and agent["ready"] and agent["remoteSaved"] and not any(lists.values())
        if agent.get("ok") is not True:
            blocking.append("agent_" + str(agent.get("code")))
        elif not well_formed:
            blocking.append("agent_report_malformed")
        elif not agent_ready:
            blocking.append("agent_not_ready")
        unsupported = scope["unsupported"]["count"]
        scan_limited = bool(busy or not complete or unsupported)
        if unsupported:
            blocking.append("unsupported_files")
        report = {
            "agentReady": agent_ready, "managedScanComplete": bool(complete), "scanLimited": scan_limited,
            "dirty": None if lists["dirty"] is None else len(lists["dirty"]) + counts["pendingMarks"],
            "uploading": None if lists["uploading"] is None else len(lists["uploading"]),
            "conflict": None if lists["conflict"] is None else len(lists["conflict"]),
            "unconfirmedOps": None if lists["unconfirmedOps"] is None else len(lists["unconfirmedOps"]),
            "open": None if lists["open"] is None else len(lists["open"]), "pendingDeletions": counts["pendingDeletions"],
            "errors": len(agent_errors) + counts["markErrors"] + (0 if well_formed else 1)}
        if counts["pendingDeletions"]:
            blocking.append("deletions_unsupported")
        verified = report["agentReady"] and report["managedScanComplete"] and not report["scanLimited"] and all(
            report[k] == 0 for k in ("dirty", "uploading", "conflict", "unconfirmedOps", "open", "pendingDeletions",
                                     "errors"))
        if w.get("pause") and not verified:  # why unsaved work could not be flushed
            blocking.append("paused_" + w.get("pause"))
        report.update(verified=verified, blocking=sorted(set(blocking)), deleteSupport="unsupported",
                      scope=dict(scope, tracked=counts["tracked"]), deletionSamples=counts["deletionSamples"],
                      agentErrors=sorted(set(str(e) for e in agent_errors)), pause=w.get("pause"),
                      draining=bool(w.get("draining", False)),
                      elapsedMs=int((time.monotonic() - started) * 1000))
        return report

    def resume(self, a):
        if not self.lock.acquire(time.monotonic() + 2):
            if self.watcher.get("draining", False):
                raise WatchError("watcher_busy")
            self._flag(self.resume_flag)  # the running watcher clears its pause at the next tick
            return {"deferred": True}
        with self.watcher._tx():
            for key, value in (("draining", False), ("pause", None), ("failures", 0), ("backoffUntil", 0)):
                self.watcher.put(key, value)
        self._unflag(self.drain_flag)
        self._unflag(self.resume_flag)
        agent = self.runner(["resume"], timeout=30)
        return {"draining": False, "agentResumed": bool(agent.get("ok")),
                "agentCode": None if agent.get("ok") else agent.get("code")}


def build_parser():
    parser = argparse.ArgumentParser(prog="files-watch.py", description=__doc__.splitlines()[0])
    parser.add_argument("--state", required=True, help="private watcher state directory (journal, lock, config)")
    parser.add_argument("--agent", required=True, help="path of files-agent.py")
    parser.add_argument("--agent-state", required=True, help="the files agent --state directory")
    parser.add_argument("--capability", help="capability file passed to the agent (never read here)")
    parser.add_argument("--root", default=DEFAULT_ROOT, help="managed workspace root (must equal the agent root)")
    parser.add_argument("--allow", action="append", help="opt a cache/VCS/dependency dir name into scope")
    parser.add_argument("--max-file-bytes", type=int, default=MAX_FILE_BYTES)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("scan-once", "run"):
        cmd = sub.add_parser(name)
        cmd.add_argument("--max-entries", type=int, default=MAX_TICK_ENTRIES)
        cmd.add_argument("--debounce", type=float, default=DEFAULT_DEBOUNCE)
        cmd.add_argument("--max-marks", type=int, default=DEFAULT_MARKS)
        if name == "scan-once":
            cmd.add_argument("--sync", action="store_true", help="also run one sync round if due")
        else:
            cmd.add_argument("--interval", type=float, default=5.0)
            cmd.add_argument("--max-runtime", type=float, default=MAX_RUNTIME)
    sub.add_parser("status")
    end = sub.add_parser("prepare-end")
    end.add_argument("--timeout", type=float, default=25.0)
    end.add_argument("--end-max-entries", type=int, default=END_MAX_ENTRIES)
    sub.add_parser("resume")
    return parser


def main(argv=None, runner=None):
    args = build_parser().parse_args(argv)
    with contextlib.suppress(AttributeError):
        sys.stdout.reconfigure(encoding="utf-8")
    if os.name != "nt":
        os.umask(0o077)
    session = None
    try:
        session = Session(args, runner)
        result = {"scan-once": session.scan_once, "run": session.run, "prepare-end": session.prepare_end,
                  "resume": session.resume, "status": lambda _a: session.watcher.status()}[args.command](args)
    except WatchError as err:
        print(json.dumps({"ok": False, "code": err.code}))
        return 2
    except sqlite3.OperationalError:
        print(json.dumps({"ok": False, "code": "state_busy"}))
        return 2
    except OSError:
        print(json.dumps({"ok": False, "code": "io_error"}))
        return 2
    finally:
        if session:
            session.close()
    print(json.dumps(dict(result, ok=True), sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
