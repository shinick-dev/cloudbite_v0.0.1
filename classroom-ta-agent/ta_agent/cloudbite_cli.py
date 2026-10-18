"""Run the cloudbite assistant bot.

    python -m ta_agent.cloudbite_cli --origin https://k.shinick.dev --course genai-101

The assistant token comes from the TA_CLOUDBITE_TOKEN environment variable (never from argv, so it
does not land in shell history or process listings). OpenRouter settings come from the usual env vars;
inside a lab sandbox point OPENROUTER_BASE_URL at the gateway proxy, e.g.
    OPENROUTER_BASE_URL=https://gw-shinick.<account>.workers.dev/p/openrouter/api/v1
    OPENROUTER_API_KEY=kvt_...
"""
from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path

from .agent import TeachingAssistant
from .cloudbite import AssistantBot, AssistantClient
from .config import Settings


def main() -> None:
    parser = argparse.ArgumentParser(description="cloudbite classroom assistant bot")
    parser.add_argument("--origin", default=os.getenv("TA_CLOUDBITE_ORIGIN", ""), help="classroom origin, e.g. https://k.shinick.dev")
    parser.add_argument("--course", default=os.getenv("TA_CLOUDBITE_COURSE_ID"), help="course id from the course files")
    # Default lives outside any repository so reply texts are never committed by accident.
    default_state = os.getenv("TA_CLOUDBITE_STATE") or str(Path.home() / ".classroom-ta" / "cloudbite-bot-state.json")
    parser.add_argument("--state", default=default_state, help="file that remembers sent replies")
    parser.add_argument("--poll", type=float, default=5.0, help="seconds between polls")
    parser.add_argument("--once", action="store_true", help="answer open questions once and exit")
    args = parser.parse_args()

    logging.basicConfig(level=os.getenv("TA_LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s")
    token = os.getenv("TA_CLOUDBITE_TOKEN", "").strip()
    if not token:
        raise SystemExit("TA_CLOUDBITE_TOKEN is not set")
    if not args.origin.startswith("https://"):
        raise SystemExit("--origin must be an https:// URL")

    settings = Settings.from_env()
    bot = AssistantBot(
        AssistantClient(args.origin, token),
        TeachingAssistant(settings),
        course_id=args.course,
        state_path=Path(args.state).expanduser(),
        poll_seconds=args.poll,
    )
    if args.once:
        print(f"answered {bot.run_once()} question(s) in lab {bot.lab_name or bot.lab_id}")
    else:
        bot.run_forever()


if __name__ == "__main__":
    main()
