"""Chat with the assistant from a terminal.

python -m ta_agent.cli [--role student|instructor] [--course <id>]
"""
from __future__ import annotations

import argparse

from .agent import TeachingAssistant
from .config import Settings
from .persona import ROLES


def main() -> None:
    parser = argparse.ArgumentParser(description="Classroom TA agent CLI")
    parser.add_argument("--role", choices=ROLES, default="student")
    parser.add_argument("--course", default=None, help="course id (required when several are configured)")
    args = parser.parse_args()

    settings = Settings.from_env()
    ta = TeachingAssistant(settings)
    course = settings.course(args.course)
    history: list[dict[str, str]] = []
    print(f"[{course.title}] TA {course.persona_name or settings.persona_name} ready. Type 'exit' to quit.")
    while True:
        try:
            message = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if message.lower() in {"exit", "quit"}:
            break
        reply = ta.respond(message, role=args.role, course_id=course.id, history=history)
        print(reply.text + (f"  (blocked: {reply.reason})" if reply.blocked else ""))
        # Keep only clean exchanges in history; failed or blocked turns would poison later context.
        if not reply.blocked and reply.reason is None:
            history += [{"role": "user", "content": message}, {"role": "assistant", "content": reply.text}]


if __name__ == "__main__":
    main()
