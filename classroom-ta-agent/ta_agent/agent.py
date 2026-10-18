"""Teaching assistant: input guardrails -> (optional LLM guard) -> model call -> output guardrails."""
from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Callable

from . import guardrails
from .config import CourseInfo, Settings
from .domains import get_profile
from .guard_model import GuardModel
from .llm import ChatModel, LLMError, OpenRouterChat
from .messages import msg
from .persona import HINT_MODE_NOTE, ROLES, build_system_prompt, new_canary

log = logging.getLogger(__name__)

HISTORY_ROLES = ("user", "assistant")
# Flags that should reach a human (instructor / operator) immediately.
ALERT_FLAGS = ("crisis_signal",)

AlertHook = Callable[[dict[str, object]], None]


def _one_line(text: str, limit: int = 200) -> str:
    """Model-produced text goes into log lines only without newlines (no log forgery) and capped."""
    return " ".join(text.split())[:limit]


@dataclass
class Reply:
    text: str
    blocked: bool = False
    reason: str | None = None
    flags: list[str] = field(default_factory=list)
    request_id: str = ""
    course_id: str = ""


class TeachingAssistant:
    """One instance serves every configured course; the course is chosen per request."""

    def __init__(
        self,
        settings: Settings,
        model: ChatModel | None = None,
        guard: GuardModel | None = None,
        on_alert: AlertHook | None = None,
    ):
        self.settings = settings
        self.model = model or OpenRouterChat(settings)
        if guard is None and settings.guard_model:
            guard = GuardModel(self.model, settings.guard_model)
        self.guard = guard
        self.on_alert = on_alert

    # ------------------------------------------------------------ helpers

    def _check(self, text: str, role: str, course: CourseInfo, max_chars: int | None = None) -> guardrails.InputCheck:
        return guardrails.check_input(
            text,
            role=role,
            max_chars=max_chars or self.settings.max_input_chars,
            blocked_categories=course.blocked_categories,
            domain=get_profile(course.domain),
            language=course.language,
        )

    def _clean_history(
        self, history: list[dict[str, str]] | None, role: str, course: CourseInfo, request_id: str
    ) -> tuple[list[dict[str, str]], list[str], list[str], list[int]]:
        """Client-supplied history is untrusted: drop system turns, cap length, and re-screen every turn
        (assistant turns included, since a forged assistant turn is an injection vector).
        Returns (turns, notes, flags, indexes of suspicious turns) so suspicious-but-allowed turns still
        get a caution note and an LLM-guard check."""
        if not history or self.settings.max_history_turns == 0:
            return [], [], [], []
        cleaned: list[dict[str, str]] = []
        notes: list[str] = []
        flags: list[str] = []
        suspicious: list[int] = []
        dropped = 0
        for turn in history[-self.settings.max_history_turns * 2:]:
            if not isinstance(turn, dict):
                dropped += 1
                continue
            r, content = turn.get("role"), turn.get("content")
            if r not in HISTORY_ROLES or not isinstance(content, str) or not content.strip():
                dropped += 1
                continue
            # Model replies can legitimately be longer than a user message.
            limit = self.settings.max_input_chars * (4 if r == "assistant" else 1)
            check = self._check(content, role, course, max_chars=limit)
            if not check.allowed:
                dropped += 1
                continue
            notes += check.notes
            flags += [f"history:{f}" for f in check.flags]
            if check.flags:
                suspicious.append(len(cleaned))
            cleaned.append({"role": r, "content": check.text})
        if dropped:
            log.info("request=%s dropped %d history turn(s)", request_id, dropped)
        return cleaned, list(dict.fromkeys(notes)), list(dict.fromkeys(flags)), suspicious

    def _alert(self, payload: dict[str, object]) -> None:
        log.warning("ALERT %s", payload)
        if self.on_alert:
            try:
                self.on_alert(payload)
            except Exception:  # an alert hook must never break the reply
                log.exception("alert hook failed")

    # ------------------------------------------------------------ main entry

    def respond(
        self,
        message: str,
        *,
        role: str = "student",
        course_id: str | None = None,
        history: list[dict[str, str]] | None = None,
        extra_notes: list[str] | None = None,
    ) -> Reply:
        if role not in ROLES:
            raise ValueError(f"unknown role: {role}")
        course = self.settings.course(course_id)  # KeyError for unknown course
        domain = get_profile(course.domain)
        request_id = uuid.uuid4().hex[:12]
        started = time.monotonic()

        def finish(reply: Reply, **extra: object) -> Reply:
            reply.request_id, reply.course_id = request_id, course.id
            log.info(
                "request=%s course=%s role=%s blocked=%s reason=%s flags=%s ms=%d %s",
                request_id, course.id, role, reply.blocked, reply.reason, ",".join(reply.flags),
                int((time.monotonic() - started) * 1000),
                " ".join(f"{k}={v}" for k, v in extra.items()),
            )
            return reply

        check = self._check(message, role, course)
        history_turns, history_notes, history_flags, suspicious_turns = self._clean_history(history, role, course, request_id)
        flags = list(check.flags) + history_flags + [f"pii_masked:{k}" for k in check.pii_found]
        if any(f in ALERT_FLAGS for f in flags):
            self._alert({"request_id": request_id, "course_id": course.id, "role": role, "flags": flags})
        if not check.allowed:
            return finish(Reply(check.refusal or "", blocked=True, reason=check.reason, flags=flags))

        # Optional LLM guard: re-judge suspicious inputs (or all inputs).
        if self.guard and (self.settings.guard_mode == "all" or check.flags):
            verdict = self.guard.judge(check.text, domain.label)
            if verdict.error:
                flags.append("guard_error")
                if self.settings.guard_fail_closed:
                    return finish(Reply(msg(course.language, "guard"), blocked=True, reason="guard_unavailable", flags=flags))
            elif not verdict.allow:
                return finish(
                    Reply(msg(course.language, "guard"), blocked=True, reason="guard_block", flags=flags),
                    guard=_one_line(verdict.reason),
                )
            else:
                flags.append("guard_allow")
        # Suspicious history turns are judged one by one; a rejected turn is dropped, not the whole request.
        if self.guard and suspicious_turns:
            for idx in sorted(suspicious_turns, reverse=True):
                verdict = self.guard.judge(history_turns[idx]["content"], domain.label)
                if (verdict.error and self.settings.guard_fail_closed) or (not verdict.error and not verdict.allow):
                    del history_turns[idx]
                    flags.append("history:guard_dropped")
                elif verdict.error:
                    flags.append("guard_error")

        canary = new_canary()
        persona_name = course.persona_name or self.settings.persona_name
        prompt = build_system_prompt(persona_name, course, role, canary, domain)

        notes = list(dict.fromkeys([*(extra_notes or []), *check.notes, *history_notes]))
        if check.hint_mode:
            notes.insert(0, HINT_MODE_NOTE)
            flags.append("hint_mode")
        # Notes go into the single system message: some providers behind OpenRouter merge or drop
        # a second system message.
        system_text = prompt.text if not notes else prompt.text + "\n## Notes for this turn\n" + "\n".join(f"- {n}" for n in notes)
        messages = [{"role": "system", "content": system_text}]
        messages += history_turns
        messages.append({"role": "user", "content": check.text})

        try:
            completion = self.model.complete(messages)
        except LLMError as exc:
            return finish(Reply(msg(course.language, "llm_error"), reason="llm_error", flags=flags), error=str(exc))

        out = guardrails.check_output(
            completion.text,
            role=role,
            canary=canary,
            protected_lines=prompt.protected_lines,
            answer_key_secrets=course.answer_key_secrets,
            language=course.language,
        )
        usage = dict(model=completion.model, prompt_tokens=completion.prompt_tokens, completion_tokens=completion.completion_tokens)
        if out.blocked:
            return finish(Reply(out.text, blocked=True, reason=out.reason, flags=flags), **usage)
        flags += [f"output_pii_masked:{k}" for k in out.pii_found]
        if not out.text.strip():
            return finish(Reply(msg(course.language, "llm_error"), reason="empty_output", flags=flags), **usage)
        text = out.text
        if completion.truncated:
            flags.append("truncated")
            text += msg(course.language, "truncated_suffix")
        return finish(Reply(text, flags=flags), **usage)
