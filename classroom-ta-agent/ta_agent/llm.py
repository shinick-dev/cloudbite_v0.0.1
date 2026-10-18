"""OpenRouter (OpenAI-compatible API) client."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Protocol

import httpx
from openai import APIStatusError, OpenAI, OpenAIError

from .config import Settings

log = logging.getLogger(__name__)


class LLMError(RuntimeError):
    """Model call failed. Users only ever see a generic message."""


@dataclass
class Completion:
    text: str
    finish_reason: str | None = None
    model: str | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None

    @property
    def truncated(self) -> bool:
        return self.finish_reason == "length"


class ChatModel(Protocol):
    def complete(self, messages: list[dict[str, str]], **overrides: object) -> Completion: ...


class OpenRouterChat:
    def __init__(self, settings: Settings):
        headers = {"X-Title": settings.app_title}
        if settings.app_url:
            headers["HTTP-Referer"] = settings.app_url
        self._client = OpenAI(
            api_key=settings.api_key,
            base_url=settings.base_url,
            timeout=settings.request_timeout,
            max_retries=settings.max_retries,
            default_headers=headers,
        )
        self._settings = settings

    def complete(self, messages: list[dict[str, str]], **overrides: object) -> Completion:
        s = self._settings
        kwargs: dict[str, object] = dict(
            model=overrides.get("model", s.model),
            messages=messages,
            temperature=overrides.get("temperature", s.temperature),
            max_tokens=overrides.get("max_tokens", s.max_output_tokens),
        )
        # OpenRouter extension: fallback model list used when the primary model fails.
        if s.fallback_models and "model" not in overrides:
            kwargs["extra_body"] = {"models": [s.model, *s.fallback_models]}
        try:
            resp = self._client.chat.completions.create(**kwargs)
        except APIStatusError as exc:
            log.error("OpenRouter API error: status=%s type=%s", exc.status_code, type(exc).__name__)
            raise LLMError(f"model call failed (HTTP {exc.status_code})") from exc
        except (OpenAIError, httpx.HTTPError) as exc:
            log.error("OpenRouter call error: type=%s", type(exc).__name__)
            raise LLMError("model call failed") from exc
        except Exception as exc:  # response parsing etc. -> generic message instead of a 500
            log.exception("unexpected error while calling OpenRouter")
            raise LLMError("model call failed") from exc

        if not resp.choices:
            raise LLMError("model returned no choices")
        choice = resp.choices[0]
        usage = getattr(resp, "usage", None)
        return Completion(
            text=choice.message.content or "",
            finish_reason=choice.finish_reason,
            model=getattr(resp, "model", None),
            prompt_tokens=getattr(usage, "prompt_tokens", None),
            completion_tokens=getattr(usage, "completion_tokens", None),
        )
