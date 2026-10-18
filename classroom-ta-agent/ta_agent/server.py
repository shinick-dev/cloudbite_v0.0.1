"""HTTP API (FastAPI).

Run: uvicorn ta_agent.server:app --host 0.0.0.0 --port 8000

Authentication: Authorization: Bearer <token>
- token == TA_INSTRUCTOR_TOKEN -> instructor mode
- token == TA_STUDENT_TOKEN    -> student mode
The role comes only from the token; the request body cannot claim instructor mode.
"""
from __future__ import annotations

import hmac
import logging
import os
import threading
import time
from collections import OrderedDict
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field

from .agent import TeachingAssistant
from .config import Settings, _env_int
from .persona import INSTRUCTOR, STUDENT

logging.basicConfig(level=os.getenv("TA_LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger(__name__)


class Turn(BaseModel):
    role: str = Field(max_length=20)
    content: str = Field(max_length=8000)


class ChatRequest(BaseModel):
    message: str = Field(max_length=8000)
    course_id: str | None = Field(default=None, max_length=100)
    history: list[Turn] = Field(default_factory=list, max_length=50)


class ChatResponse(BaseModel):
    reply: str
    blocked: bool
    reason: str | None = None
    flags: list[str] = Field(default_factory=list)
    role: str
    course_id: str
    request_id: str


class RateLimiter:
    """Sliding-window limiter keyed by client; single-process. Bounded memory (LRU of keys)."""

    def __init__(self, limit: int, window_s: float = 60.0, max_keys: int = 10_000):
        self.limit, self.window, self.max_keys = limit, window_s, max_keys
        self._hits: OrderedDict[str, list[float]] = OrderedDict()
        self._lock = threading.Lock()

    def _window(self, key: str, now: float) -> list[float]:
        q = self._hits.pop(key, [])
        q = [t for t in q if now - t <= self.window]
        self._hits[key] = q
        while len(self._hits) > self.max_keys:
            self._hits.popitem(last=False)
        return q

    def allow(self, key: str) -> bool:
        """Count this event and say whether it is within the limit."""
        now = time.monotonic()
        with self._lock:
            q = self._window(key, now)
            allowed = len(q) < self.limit
            if allowed:
                q.append(now)
            return allowed

    def over(self, key: str) -> bool:
        """Is the key already at the limit? Does not count an event."""
        with self._lock:
            return len(self._window(key, time.monotonic())) >= self.limit

    def hit(self, key: str) -> None:
        """Count an event (used for failed authentication attempts)."""
        with self._lock:
            self._window(key, time.monotonic()).append(time.monotonic())


def _match(token: str, expected: str) -> bool:
    return bool(expected) and hmac.compare_digest(token.encode(), expected.encode())


def create_app(assistant: TeachingAssistant | None = None) -> FastAPI:
    instructor_token = os.getenv("TA_INSTRUCTOR_TOKEN", "")
    student_token = os.getenv("TA_STUDENT_TOKEN", "")
    if not instructor_token and not student_token:
        raise RuntimeError("set TA_INSTRUCTOR_TOKEN and/or TA_STUDENT_TOKEN")
    if instructor_token and instructor_token == student_token:
        raise RuntimeError("instructor and student tokens must differ")
    for name, value in (("TA_INSTRUCTOR_TOKEN", instructor_token), ("TA_STUDENT_TOKEN", student_token)):
        if value and len(value) < 16:
            raise RuntimeError(f"{name} must be at least 16 characters")

    per_min = _env_int("TA_RATE_LIMIT_PER_MIN", 20, minimum=1)
    # Three buckets: failed auth attempts per IP (token guessing), chats per session (one learner),
    # and chats per IP (a whole classroom behind one NAT; also bounds X-Session-Id rotation).
    auth_fail_limiter = RateLimiter(_env_int("TA_AUTH_FAIL_LIMIT_PER_MIN", 10, minimum=1))
    chat_limiter = RateLimiter(per_min)
    ip_limiter = RateLimiter(_env_int("TA_RATE_LIMIT_PER_IP_PER_MIN", per_min * 20, minimum=1))

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Fail at startup, not on the first request, when configuration is broken.
        if app.state.assistant is None:
            app.state.assistant = TeachingAssistant(Settings.from_env())
        log.info("courses loaded: %s", ", ".join(app.state.assistant.settings.courses))
        yield

    app = FastAPI(title="Classroom TA Agent", lifespan=lifespan)
    app.state.assistant = assistant

    def client_ip(request: Request) -> str:
        # Trust X-Forwarded-For only when explicitly enabled behind a trusted proxy, and then use the
        # entry that proxy appended (the rightmost); the leftmost is whatever the client sent.
        if os.getenv("TA_TRUST_PROXY", "").lower() in ("1", "true", "yes"):
            fwd = request.headers.get("x-forwarded-for")
            if fwd:
                return fwd.split(",")[-1].strip()
        return request.client.host if request.client else "unknown"

    def resolve_role(request: Request, authorization: str = Header(default="")) -> str:
        ip = client_ip(request)
        if auth_fail_limiter.over(f"auth:{ip}"):
            raise HTTPException(status_code=429, detail="too many failed authentication attempts")
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() == "bearer" and token:
            if _match(token, instructor_token):
                return INSTRUCTOR
            if _match(token, student_token):
                return STUDENT
        auth_fail_limiter.hit(f"auth:{ip}")  # only failures count toward the auth limit
        raise HTTPException(status_code=401, detail="invalid or missing token")

    @app.get("/health")
    def health() -> dict[str, object]:
        ta: TeachingAssistant | None = app.state.assistant
        return {"status": "ok", "courses": len(ta.settings.courses) if ta else 0}

    @app.post("/chat", response_model=ChatResponse)
    def chat(body: ChatRequest, request: Request, role: str = Depends(resolve_role)) -> ChatResponse:
        # Per-session bucket (X-Session-Id lets learners behind one NAT have their own) plus a larger
        # per-IP bucket so rotating session ids cannot escape the limit.
        ip = client_ip(request)
        session = request.headers.get("x-session-id", "")[:64]
        if not ip_limiter.allow(f"ip:{ip}") or not chat_limiter.allow(f"{role}:{ip}:{session}"):
            raise HTTPException(status_code=429, detail="too many requests, please wait a moment")
        ta: TeachingAssistant = app.state.assistant
        try:
            reply = ta.respond(
                body.message, role=role, course_id=body.course_id,
                history=[t.model_dump() for t in body.history],
            )
        except KeyError as exc:
            raise HTTPException(status_code=400, detail=str(exc.args[0])) from exc
        return ChatResponse(
            reply=reply.text, blocked=reply.blocked, reason=reply.reason, flags=reply.flags,
            role=role, course_id=reply.course_id, request_id=reply.request_id,
        )

    return app


def __getattr__(name: str):  # lets `uvicorn ta_agent.server:app` work without env checks at import time
    if name == "app":
        globals()["app"] = create_app()
        return globals()["app"]
    raise AttributeError(name)
