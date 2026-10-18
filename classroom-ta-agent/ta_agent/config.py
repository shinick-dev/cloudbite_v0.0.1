"""Settings: environment variables plus per-course JSON files."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
KNOWN_CATEGORIES = ("self_harm", "violence", "illegal", "sexual", "minor_unsafe")
LANGUAGES = ("ko", "en")


def _env_int(name: str, default: int, minimum: int | None = None) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from exc
    if minimum is not None and value < minimum:
        raise ValueError(f"{name} must be >= {minimum}, got {value}")
    return value


def _env_float(name: str, default: float, minimum: float, maximum: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number, got {raw!r}") from exc
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}, got {value}")
    return value


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _require_str_list(name: str, value: object) -> None:
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ValueError(f"course field '{name}' must be a list of strings")


@dataclass
class CourseInfo:
    """One course. `answer_key_secrets` never enters the prompt; it is used only for output checks."""

    id: str = "default"
    title: str = "Internal training"
    domain: str = "general"
    language: str = "ko"  # language the assistant replies in
    instructor: str = "the instructor"
    persona_name: str = ""  # empty -> Settings.persona_name
    description: str = ""
    schedule: list[str] = field(default_factory=list)
    topics: list[str] = field(default_factory=list)
    materials: list[str] = field(default_factory=list)
    faq: list[dict[str, str]] = field(default_factory=list)
    answer_key_secrets: list[str] = field(default_factory=list)
    blocked_categories: list[str] = field(
        default_factory=lambda: ["self_harm", "violence", "illegal", "sexual"]
    )

    def __post_init__(self) -> None:
        for name in ("id", "title", "domain", "language", "instructor", "persona_name", "description"):
            if not isinstance(getattr(self, name), str):
                raise ValueError(f"course field '{name}' must be a string")
        if not self.id.strip():
            raise ValueError("course field 'id' must not be empty")
        if self.language not in LANGUAGES:
            raise ValueError(f"course field 'language' must be one of {LANGUAGES}")
        for name in ("schedule", "topics", "materials", "answer_key_secrets", "blocked_categories"):
            _require_str_list(name, getattr(self, name))
        if not isinstance(self.faq, list) or not all(
            isinstance(i, dict) and all(isinstance(v, str) for v in i.values()) for i in self.faq
        ):
            raise ValueError("course field 'faq' must be a list of {\"q\": ..., \"a\": ...} objects")
        unknown = set(self.blocked_categories) - set(KNOWN_CATEGORIES)
        if unknown:
            raise ValueError(
                f"unknown blocked_categories {sorted(unknown)}; allowed: {', '.join(KNOWN_CATEGORIES)}"
            )
        # Validate the domain key here (imported lazily to avoid a circular import).
        from .domains import get_profile

        get_profile(self.domain)

    @classmethod
    def load(cls, path: str | os.PathLike[str]) -> "CourseInfo":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError(f"{path}: top-level value must be a JSON object")
        unknown = set(data) - set(cls.__dataclass_fields__)
        if unknown:
            raise ValueError(f"{path}: unknown keys {sorted(unknown)}")
        data.setdefault("id", Path(path).stem.removesuffix(".example"))
        return cls(**data)


def load_courses(course_file: str | None, courses_dir: str | None) -> dict[str, CourseInfo]:
    """Load courses from TA_COURSES_DIR (many) and/or TA_COURSE_FILE (one). Neither -> a default course."""
    paths: list[Path] = []
    if courses_dir:
        paths += sorted(Path(courses_dir).glob("*.json"))
        if not paths:
            raise ValueError(f"no course files (*.json) found in {courses_dir}")
    if course_file:
        paths.append(Path(course_file))
    courses = [CourseInfo.load(p) for p in paths] or [CourseInfo()]
    result: dict[str, CourseInfo] = {}
    for c in courses:
        if c.id in result:
            raise ValueError(f"duplicate course id: {c.id}")
        result[c.id] = c
    return result


@dataclass
class Settings:
    api_key: str
    model: str = "openai/gpt-4o-mini"
    fallback_models: list[str] = field(default_factory=list)
    base_url: str = OPENROUTER_BASE_URL
    temperature: float = 0.3
    max_output_tokens: int = 800
    request_timeout: float = 30.0
    max_retries: int = 1
    app_url: str = ""
    app_title: str = "Classroom TA Agent"
    max_input_chars: int = 2000
    max_history_turns: int = 10
    persona_name: str = "Hana"
    # Optional LLM guard classifier. Empty model id disables it.
    # guard_mode "flagged": re-check only inputs the rules found suspicious; "all": check every input.
    guard_model: str = ""
    guard_mode: str = "flagged"
    guard_fail_closed: bool = False
    courses: dict[str, CourseInfo] = field(default_factory=lambda: {"default": CourseInfo()})

    def __post_init__(self) -> None:
        if self.guard_mode not in ("flagged", "all"):
            raise ValueError("TA_GUARD_MODE must be 'flagged' or 'all'")
        if not self.courses:
            raise ValueError("at least one course is required")

    def course(self, course_id: str | None) -> CourseInfo:
        if course_id is None:
            if len(self.courses) == 1:
                return next(iter(self.courses.values()))
            raise KeyError("course_id is required when more than one course is configured")
        if course_id not in self.courses:
            raise KeyError(f"unknown course: {course_id}")
        return self.courses[course_id]

    @classmethod
    def from_env(cls) -> "Settings":
        api_key = os.getenv("OPENROUTER_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError("OPENROUTER_API_KEY is not set")
        fallbacks = [m.strip() for m in os.getenv("OPENROUTER_FALLBACK_MODELS", "").split(",") if m.strip()]
        return cls(
            api_key=api_key,
            model=os.getenv("OPENROUTER_MODEL", cls.model),
            fallback_models=fallbacks,
            base_url=os.getenv("OPENROUTER_BASE_URL", OPENROUTER_BASE_URL),
            temperature=_env_float("TA_TEMPERATURE", cls.temperature, 0.0, 2.0),
            max_output_tokens=_env_int("TA_MAX_OUTPUT_TOKENS", cls.max_output_tokens, 1),
            request_timeout=_env_float("TA_REQUEST_TIMEOUT", cls.request_timeout, 1.0, 300.0),
            max_retries=_env_int("TA_MAX_RETRIES", cls.max_retries, 0),
            app_url=os.getenv("OPENROUTER_APP_URL", ""),
            app_title=os.getenv("OPENROUTER_APP_TITLE", cls.app_title),
            max_input_chars=_env_int("TA_MAX_INPUT_CHARS", cls.max_input_chars, 1),
            max_history_turns=_env_int("TA_MAX_HISTORY_TURNS", cls.max_history_turns, 0),
            persona_name=os.getenv("TA_PERSONA_NAME", cls.persona_name),
            guard_model=os.getenv("TA_GUARD_MODEL", ""),
            guard_mode=os.getenv("TA_GUARD_MODE", "flagged"),
            guard_fail_closed=_env_bool("TA_GUARD_FAIL_CLOSED"),
            courses=load_courses(os.getenv("TA_COURSE_FILE"), os.getenv("TA_COURSES_DIR")),
        )
