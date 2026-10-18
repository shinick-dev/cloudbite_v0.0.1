"""Connector for the cloudbite classroom (shinick-dev/cloudbite_v0.0.1, branch agent_chatbot).

The classroom Worker keeps AI out of the server: the instructor issues a scoped *assistant grant*
(token `la_...`) and an external bot uses the assistant API with the `x-lab-assistant` header.
This module is that bot. It only ever uses three scopes:

  status:read   -> which lab / seats this grant covers, and whether the lab is paused or ended
  help:read     -> learner questions for those seats
  help:reply    -> one final reply per open question

It never calls `template` or `pause`: sending approved request texts or pausing the whole class
are instructor decisions, not something an AI should trigger on its own.

API contract (docs/classroom-assistants.md in that repo):
  - every route is POST JSON at <ORIGIN>/api/lab/assistant/<action>, bodies capped at 10,000 bytes
  - a direct HTTP client sends the token only in the `x-lab-assistant` header, never in URLs or bodies
  - writes carry a UUIDv4 `requestId`; on an unknown outcome the *same* id and body are re-sent,
    a different body with the same id is rejected (409), and new ids are never generated for retries
  - a reply is 1..2000 UTF-16 units; 401 = grant revoked/expired, 403 = wrong lab/scope/seat,
    410 = lab ended, 429 = grant operation cap (128) or storage budget
"""
from __future__ import annotations

import json
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import httpx

from .agent import TeachingAssistant
from .messages import msg

log = logging.getLogger(__name__)

TOKEN_RE = re.compile(r"^la_[A-Za-z0-9_-]{43}$")
QUESTION_ID_RE = re.compile(r"^hq_[0-9a-f-]{36}$")
REPLY_MAX_CHARS = 2000
USED_SCOPES = ("status:read", "help:read", "help:reply")
# The Worker allows 128 write operations per grant; stop composing before that so the instructor
# can issue a new grant, and warn earlier.
WRITE_BUDGET = 120
WRITE_WARN = 100
ONE_SHOT_NOTE = (
    "This is a one-shot help-desk reply: the learner cannot answer back in this thread and you have "
    "no access to their terminal or files. Do not ask the learner questions; give the complete hint or "
    "explanation in one message, and say what to check themselves when you lack their screen."
)


def clean_surrogates(text: str) -> str:
    """JSON from the Worker or the model may carry lone surrogates (e.g. a split emoji escape); they
    would make UTF-8 encoding raise, so replace them."""
    return text.encode("utf-8", errors="replace").decode("utf-8")


class AssistantApiError(RuntimeError):
    def __init__(self, status: int, error: str, *, unknown: bool = False):
        super().__init__(f"HTTP {status}: {error}" if status else error)
        self.status = status
        self.error = error
        self.unknown = unknown  # outcome unknown (timeout / transport / 5xx) -> retry with the same requestId

    @property
    def fatal(self) -> bool:
        """401 grant revoked/expired, 403 wrong lab or scope, 410 lab ended: stop the bot."""
        return self.status in (401, 403, 410)


class AssistantClient:
    """Thin HTTP client for the scoped assistant API."""

    def __init__(self, origin: str, token: str, *, timeout: float = 10.0, transport: httpx.BaseTransport | None = None):
        if not TOKEN_RE.match(token):
            raise ValueError("assistant token must look like la_<43 chars>")
        self._origin = origin.rstrip("/")
        self._client = httpx.Client(
            base_url=self._origin,
            headers={"x-lab-assistant": token, "content-type": "application/json"},
            timeout=timeout,
            transport=transport,
        )

    def _post(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        # ensure_ascii=False: the Worker caps bodies at 10,000 *bytes*; \uXXXX escapes would inflate a
        # 2,000-char Korean reply to ~12 KB and get a 413.
        payload = clean_surrogates(json.dumps(body, ensure_ascii=False)).encode("utf-8")
        try:
            r = self._client.post(f"/api/lab/assistant/{action}", content=payload)
        except httpx.TimeoutException as exc:
            raise AssistantApiError(0, "timeout", unknown=True) from exc
        except httpx.HTTPError as exc:
            raise AssistantApiError(0, type(exc).__name__, unknown=True) from exc
        try:
            data = r.json()
        except ValueError:
            data = None
        # Classify by status first: a non-JSON 4xx (e.g. an HTML rate-limit page) is still a known 4xx.
        if r.status_code >= 500:
            raise AssistantApiError(r.status_code, "server error", unknown=True)
        if r.status_code >= 400:
            error = str(data.get("error", "")) if isinstance(data, dict) else f"non-JSON {r.status_code} response"
            raise AssistantApiError(r.status_code, error)
        if not isinstance(data, dict):
            raise AssistantApiError(r.status_code, "bad response", unknown=True)
        return data

    def status(self) -> dict[str, Any]:
        return self._post("status", {})

    def questions(self, lab_id: str) -> dict[str, Any]:
        return self._post("questions", {"id": lab_id})

    def reply(self, lab_id: str, request_id: str, question_id: str, text: str) -> dict[str, Any]:
        return self._post("reply", {"id": lab_id, "requestId": request_id, "questionId": question_id, "text": text})

    def close(self) -> None:
        self._client.close()


@dataclass
class PendingReply:
    request_id: str
    text: str
    attempts: int = 0


@dataclass
class BotState:
    """Persisted so a restart re-sends the same requestId + text instead of inventing a new one."""

    pending: dict[str, PendingReply] = field(default_factory=dict)  # question id -> reply in flight
    done: dict[str, str] = field(default_factory=dict)  # question id -> request id
    held: list[str] = field(default_factory=list)  # question ids left open on purpose (crisis)
    writes: int = 0  # confirmed replies in this grant

    @classmethod
    def load(cls, path: Path | None) -> "BotState":
        if not path or not path.exists():
            return cls()
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            return cls(
                pending={str(k): PendingReply(**v) for k, v in dict(raw.get("pending", {})).items()},
                done={str(k): str(v) for k, v in dict(raw.get("done", {})).items()},
                held=[str(x) for x in raw.get("held", [])],
                writes=int(raw.get("writes", 0)),
            )
        except (ValueError, TypeError, OSError) as exc:
            # A corrupt file cannot be trusted; keep it for inspection and start fresh. The Worker
            # rejects a second reply to an answered question (409), so no learner gets two answers.
            backup = path.with_suffix(path.suffix + ".corrupt")
            log.error("bot state %s unreadable (%s); moving it to %s and starting fresh", path, exc, backup)
            try:
                path.replace(backup)
            except OSError:
                pass
            return cls()

    def save(self, path: Path | None) -> None:
        if not path:
            return
        data = {"pending": {k: vars(v) for k, v in self.pending.items()}, "done": self.done, "held": self.held, "writes": self.writes}
        tmp = path.with_suffix(path.suffix + ".tmp")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(clean_surrogates(json.dumps(data, ensure_ascii=False, indent=1)), encoding="utf-8")
            tmp.replace(path)
        except OSError as exc:  # keep running; the next save retries
            log.warning("could not persist bot state to %s: %s", path, exc)


def js_len(text: str) -> int:
    """Length as the Worker measures it: JavaScript String.length (UTF-16 code units; emoji count 2)."""
    return len(text.encode("utf-16-le", errors="replace")) // 2


def _cut_utf16(text: str, units: int) -> str:
    raw = text.encode("utf-16-le", errors="replace")[: max(units, 0) * 2]
    return raw.decode("utf-16-le", errors="ignore")  # drops a split surrogate pair


def fit_reply(text: str, language: str) -> str:
    """The API accepts 1..2000 UTF-16 units; cut at a sentence boundary and say so."""
    text = clean_surrogates(text).strip()
    if not text:
        return msg(language, "llm_error")
    suffix = msg(language, "truncated_final")
    if text.endswith(suffix.strip()):
        text = text[: -len(suffix.strip())].rstrip()
    if js_len(text) <= REPLY_MAX_CHARS:
        return text
    room = REPLY_MAX_CHARS - js_len(suffix)
    cut = _cut_utf16(text, room)
    boundary = max(cut.rfind(". "), cut.rfind("\n"), cut.rfind("다. "))
    if boundary > len(cut) // 2:
        cut = cut[: boundary + 1]
    return _cut_utf16(cut.rstrip() + suffix, REPLY_MAX_CHARS)


class AssistantBot:
    """Polls the assistant API and answers open questions with the guarded TeachingAssistant."""

    def __init__(
        self,
        client: AssistantClient,
        assistant: TeachingAssistant,
        *,
        course_id: str | None = None,
        state_path: Path | None = None,
        poll_seconds: float = 5.0,
        max_attempts: int = 5,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.client = client
        self.assistant = assistant
        self.course_id = course_id
        self.course = assistant.settings.course(course_id)
        self.state_path = state_path
        self.state = BotState.load(state_path)
        self.poll_seconds = poll_seconds
        self.max_attempts = max_attempts
        self._sleep = sleep
        self.lab_id: str | None = None
        self.lab_name: str = ""
        self.seats: list[int] = []
        self.control_mode: str = "running"
        self.backoff = False  # set when the Worker throttles us or a reply outcome stays unknown

    # ------------------------------------------------------------ status

    def refresh_status(self) -> dict[str, Any]:
        """Re-read the grant and lab on every pass: scopes, seats and pause state can change under us."""
        data = self.client.status()
        grant = data.get("grant") if isinstance(data.get("grant"), dict) else {}
        lab = data.get("lab") if isinstance(data.get("lab"), dict) else {}
        control = data.get("control") if isinstance(data.get("control"), dict) else {}
        scopes = {s for s in (grant.get("scopes") or []) if isinstance(s, str)}
        missing = [s for s in USED_SCOPES if s not in scopes]
        if missing:
            raise RuntimeError(f"assistant grant lacks required scopes: {missing}")
        extra = sorted(scopes - set(USED_SCOPES))
        if extra and self.lab_id is None:
            log.info("grant also has %s; this bot never uses them", extra)
        if not isinstance(lab.get("id"), str) or grant.get("labId") != lab["id"]:
            raise RuntimeError("status response does not name a lab")
        self.lab_id = lab["id"]
        self.lab_name = str(lab.get("name", ""))
        self.seats = [n for n in (grant.get("seats") or []) if isinstance(n, int)]
        mode = control.get("mode")
        if mode == "ended":
            raise AssistantApiError(410, "lab ended")
        if mode != self.control_mode:
            log.info("lab %s control mode: %s", self.lab_id, mode)
        self.control_mode = str(mode or "running")
        return data

    # ------------------------------------------------------------ one pass

    def compose(self, question: dict[str, Any], prior: list[dict[str, Any]] | None = None) -> str | None:
        """Run the question through the guarded assistant and fit the reply to the API limit.
        Returns None when the question must be left open for a human (crisis signal)."""
        seat = question.get("n")
        text = clean_surrogates(str(question.get("question", "")))
        # Earlier answered threads from the same seat give the model the context the learner assumes.
        history: list[dict[str, str]] = []
        for p in prior or []:
            if isinstance(p.get("question"), str) and isinstance(p.get("reply"), str):
                history += [{"role": "user", "content": clean_surrogates(p["question"])}, {"role": "assistant", "content": clean_surrogates(p["reply"])}]
        reply = self.assistant.respond(text, role="student", course_id=self.course_id, history=history, extra_notes=[ONE_SHOT_NOTE])
        if "crisis_signal" in reply.flags:
            # The grant has no channel to the instructor and a reply would move the question out of the
            # open queue, so leave it open where a human will see it.
            log.warning("CRISIS signal from seat %s in lab %s (question %s): left OPEN for the instructor", seat, self.lab_id, question.get("id"))
            return None
        if reply.blocked:
            log.info("question=%s seat=%s agent_request=%s blocked reason=%s", question.get("id"), seat, reply.request_id, reply.reason)
        else:
            log.info("question=%s seat=%s agent_request=%s flags=%s", question.get("id"), seat, reply.request_id, ",".join(reply.flags))
        answer = reply.text
        if "truncated" in reply.flags:
            # The chat-style "say 'continue'" hint is wrong here: one final reply per question, no history.
            chat_suffix = msg(self.course.language, "truncated_suffix")
            if answer.endswith(chat_suffix):
                answer = answer[: -len(chat_suffix)]
            answer = answer.rstrip() + msg(self.course.language, "truncated_final")
        return fit_reply(answer, self.course.language)

    def _send(self, qid: str, pending: PendingReply) -> bool:
        """Post one reply. Returns False when the bot should stop this pass and back off."""
        assert self.lab_id
        pending.attempts += 1
        try:
            result = self.client.reply(self.lab_id, pending.request_id, qid, pending.text)
        except AssistantApiError as exc:
            if exc.unknown:
                # Keep the same requestId and text; never drop a learner's question silently.
                if pending.attempts >= self.max_attempts:
                    log.error("reply for %s still unconfirmed after %d tries; backing off and keeping it pending", qid, pending.attempts)
                    self.backoff = True
                    return False
                log.warning("reply outcome unknown for %s (attempt %d); will re-send the same requestId", qid, pending.attempts)
                return True
            if exc.status == 429:
                # Grant operation cap (128 per grant) or storage budget: keep the question pending and
                # back off; the instructor must issue a new grant or the limit must clear.
                log.warning("throttled by the classroom (%s); keeping %s pending", exc.error, qid)
                self.backoff = True
                return False
            if exc.status == 403:
                log.info("reply for %s refused (%s): seat not covered by this grant", qid, exc.error)
            elif exc.fatal:
                raise
            elif exc.status == 409:
                # already answered by someone else, or the seat changed: nothing more to do
                log.info("reply for %s not accepted: %s", qid, exc.error)
            elif exc.status in (400, 413):
                log.error("reply for %s rejected by the API (%s): this is a bot bug, please report it", qid, exc)
            else:
                log.error("reply for %s failed: %s", qid, exc)
            self.state.done[qid] = pending.request_id
            del self.state.pending[qid]
            return True
        # Confirm what the Worker actually recorded, as the official page does, instead of trusting a 200.
        q = result.get("question") if isinstance(result.get("question"), dict) else {}
        if q.get("id") != qid or q.get("status") not in ("answered", "resolved"):
            log.error("reply for %s returned 200 but the record does not confirm it (id=%s status=%s)", qid, q.get("id"), q.get("status"))
        self.state.done[qid] = pending.request_id
        del self.state.pending[qid]
        self.state.writes += 1
        if self.state.writes == WRITE_WARN:
            log.warning("%d of %d replies used on this grant; ask the instructor for a new grant soon", WRITE_WARN, 128)
        log.info("answered question %s (confirmed status=%s, writes=%d)", qid, q.get("status"), self.state.writes)
        return True

    def run_once(self) -> int:
        """Answer every open question once. Returns the number of replies attempted."""
        self.backoff = False
        self.refresh_status()
        assert self.lab_id
        if self.control_mode == "paused":
            # The Worker only blocks command delivery while paused, not replies, but an instructor who
            # paused the class is handling an incident; stay quiet until it resumes.
            log.info("lab %s is paused; not answering until it resumes", self.lab_id)
            return 0
        # Finish anything left from a previous run first (same requestId, same text).
        for qid, pending in list(self.state.pending.items()):
            if not self._send(qid, pending):
                self.state.save(self.state_path)
                return 0
        data = self.client.questions(self.lab_id)
        attempted = 0
        threads = [q for q in (data.get("questions") or []) if isinstance(q, dict)]
        for q in sorted(threads, key=lambda t: t.get("at") or 0):
            qid = q.get("id")
            if not isinstance(qid, str) or not QUESTION_ID_RE.match(qid):
                continue
            if q.get("status") != "open" or qid in self.state.done or qid in self.state.pending or qid in self.state.held:
                continue
            if self.seats and q.get("n") not in self.seats:
                continue
            if self.state.writes >= WRITE_BUDGET:
                log.error("reply budget (%d) for this grant is used up; %s stays open until a new grant is issued", WRITE_BUDGET, qid)
                break
            prior = [t for t in threads if t.get("n") == q.get("n") and t.get("status") in ("answered", "resolved") and t.get("id") != qid]
            text = self.compose(q, sorted(prior, key=lambda t: t.get("at") or 0))
            if text is None:
                self.state.held.append(qid)
                self.state.save(self.state_path)
                continue
            pending = PendingReply(request_id=str(uuid.uuid4()), text=text)
            self.state.pending[qid] = pending
            self.state.save(self.state_path)  # persist before the write so a crash retries the same id
            attempted += 1
            if not self._send(qid, pending):
                break
        self.state.save(self.state_path)
        return attempted

    def run_forever(self) -> None:
        log.info("assistant bot started; polling every %.0fs", self.poll_seconds)
        while True:
            try:
                self.run_once()
            except AssistantApiError as exc:
                if exc.fatal:
                    log.warning("stopping: %s", exc.error or exc)
                    return
                log.warning("poll failed: %s", exc)
            except Exception:  # malformed payloads, model errors, ... must not kill the bot mid-class
                log.exception("pass failed; will retry")
                self.backoff = True
            self._sleep(self.poll_seconds * (12 if self.backoff else 1))
