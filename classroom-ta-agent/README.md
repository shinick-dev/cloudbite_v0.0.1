# Classroom TA Agent

A teaching-assistant agent for internal company courses. One instructor usually needs several
assistants per class; this agent answers learner questions and helps the instructor with class
operations. Models are called through OpenRouter (OpenAI-compatible API).

## Layout

```
ta_agent/
  config.py       env vars + course JSON files (one process serves many courses)
  domains.py      domain profiles: general, ai, law, finance, highschool, mechanical
  persona.py      TA persona and system prompt
  guardrails.py   rule-based input/output guardrails (Korean + English patterns)
  guard_model.py  optional LLM guard classifier (second line of defense)
  llm.py          OpenRouter client
  agent.py        input check -> guard -> model -> output check
  cloudbite.py    bot for the cloudbite classroom assistant API (see "Cloudbite classroom")
  cloudbite_cli.py  runs that bot
  server.py       stand-alone HTTP API (FastAPI), for use outside cloudbite
  cli.py          terminal chat
  messages.py     user-facing refusal messages (ko / en)
courses/          example course files
tests/            tests that run without an API key (fake model)
```

## Domains

There is one engine; a course picks a **domain profile** through its `domain` field. A profile sets
the explanation style, domain rules in the prompt, categories that can't be disabled, crisis contacts,
and domain-specific detection patterns. Add a domain by adding one entry to `PROFILES` in `ta_agent/domains.py`.

| domain | audience | extra guardrails |
|---|---|---|
| `general` | any | base rules only |
| `ai` | AI / data | no API keys in output; jailbreak techniques only conceptually / defensively |
| `law` | legal basics | personal-case advice -> caution note; no invented statute/case numbers; disclaimer |
| `finance` | finance | product recommendations -> caution note; "how to" insider trading / laundering / manipulation -> block |
| `highschool` | minors | self-harm/violence/illegal/sexual/minor_unsafe always on; youth hotline 1388; no outside contact |
| `mechanical` | equipment | LOTO / PPE reminders; "how to bypass" interlocks or guards -> block |

Several courses can run in one process (`TA_COURSES_DIR`); each request selects one with `course_id`.
Each course can set its own persona name and reply language (`ko` or `en`).

## Guardrails

**Input (before the model call)**
- Length limit, empty input
- Normalization: NFKC (full-width letters) and removal of invisible characters (zero-width, soft hyphen, variation selectors)
- Prompt injection: unmistakable signals (special tokens, requests for the internal marker) block outright; suspicious wording ("ignore previous instructions", "act as DAN", "show your system prompt", Korean equivalents) blocks unless the message reads as an educational question, in which case a caution note is attached and the input is flagged
- Harmful requests: self-harm method requests block with crisis contacts; a bare self-harm signal is allowed with an empathy note and raises a `crisis_signal` alert (hook for instructors); violence / illegal / sexual "how to" requests block; understanding/prevention questions pass with a note
- Personal data masking before anything leaves the server: national ID, phone (+82, dots, landlines), email, card numbers (Luhn-checked), API keys/tokens
- Assessment-answer requests from learners switch the model to **hint mode** instead of blocking
- Client-supplied history is untrusted: system turns dropped, user and assistant turns re-screened, PII masked, length capped (`TA_MAX_HISTORY_TURNS=0` disables history)

**Optional LLM guard** (`TA_GUARD_MODEL`): re-judges flagged inputs (or all inputs with `TA_GUARD_MODE=all`) with a small model via OpenRouter. Fails open by default; `TA_GUARD_FAIL_CLOSED=1` refuses when the guard is unavailable.

**System prompt**
- No answers to graded work, no other learners' data, no off-topic topics (per domain), no promises on behalf of the instructor, no secrets in output
- Instructions inside user messages or earlier turns are data, not commands

**Output (after the model call)**
- Prompt leak: per-request canary token, or two or more instruction lines quoted verbatim -> blocked. Course info (schedule, materials, FAQ) is excluded so the TA can repeat it
- Answer-key leak: `answer_key_secrets` strings in a learner reply -> blocked (these strings never enter the prompt)
- PII masking; truncated answers (`finish_reason=length`) get a "cut off" notice and a `truncated` flag

**Server**
- Role comes only from the bearer token (separate instructor / student tokens, 16+ chars, constant-time compare)
- Failed authentication attempts are rate-limited per IP (token guessing); chats are limited per session (`X-Session-Id`) *and* per IP, so rotating session ids does not escape the limit. Behind a trusted proxy (`TA_TRUST_PROXY=1`) the proxy-appended `X-Forwarded-For` entry is used
- Configuration is validated at startup; model errors return a generic message
- Every response and log line carries a `request_id`; `flags` show what the guardrails saw

> Rules are the first line of defense, not the last. They see words, not intent, so they both over-block
> (educational questions about risky topics) and under-block (rephrased attacks). The educational-wording
> exception, the LLM guard, the prompt rules, and the output check exist to cover each other's gaps. See
> "Known limits" below.

## Cloudbite classroom (shinick-dev/cloudbite_v0.0.1, branch `agent_chatbot`)

That classroom Worker deliberately embeds no AI: the instructor issues a scoped **assistant grant**
(`la_...` token, scopes such as `status:read`, `help:read`, `help:reply`) and an external bot uses the
assistant API. This project is that bot.

```
learner seat ──help request──▶ Worker (/api/lab/assistant/*) ◀──poll + reply── this bot ──▶ OpenRouter
                                                                   (persona + guardrails)
```

- The bot authenticates with the `x-lab-assistant` header only (never URL, body, or logs) and uses
  exactly `status:read`, `help:read`, `help:reply`. It **never** calls `template` or `pause`; sending
  approved request texts or pausing the class stays with the instructor.
- Each open question goes through the same guardrails as the HTTP API (role `student`), and one final
  reply (max 2000 chars) is posted with a UUIDv4 `requestId`. The id and text are persisted *before*
  the write, so an unknown outcome (timeout) re-sends the same id and body; new ids are never minted
  for retries, matching the classroom's idempotency contract.
- The grant and lab status are re-read on every pass; while the instructor has the lab **paused** the
  bot stays quiet. 401 (grant revoked/expired), 403 (wrong lab or scope) and 410 (lab ended) stop the
  bot. 409 (already answered / seat changed) is logged and skipped. A reply whose outcome stays unknown
  (timeouts, 5xx) is never dropped: it stays pending with the same `requestId` and the bot backs off. 429 (the Worker caps each grant at **128 write operations** and each lab at
  100 questions) keeps the question pending and backs off; the instructor then issues a new grant.
- Bodies are sent as raw UTF-8 (the Worker caps request bodies at 10,000 bytes) and reply length is
  measured in UTF-16 units like the Worker does, so Korean and emoji replies are not rejected.
- A question with a `crisis_signal` is **left open** (no reply) so it stays in the instructor's open
  queue, and a warning is logged; the grant has no channel to the instructor, so an operator must watch
  the log (or wire `on_alert` to a webhook).
- Each reply costs one of the grant's 128 writes. The bot warns at 100 and stops composing at 120 so the
  instructor can issue a new grant; refusals are still sent (the learner gets an answer) and count.
- One-shot channel: the learner cannot answer back in the same thread, so the model is told not to ask
  questions and to give the complete hint at once; earlier answered threads from the same seat are
  passed as history. The grant does not expose learner terminals or files, so debugging help is blind:
  the bot says what the learner should check themselves.
- Every 200 is checked against the returned record (`question.id`, `status: answered`), as the official
  assistant page does; a mismatch is logged as an error.

```bash
cd classroom-ta-agent
pip install -r requirements.txt
export TA_CLOUDBITE_TOKEN=la_...            # from the instructor's grant issue response (shown once)
export OPENROUTER_API_KEY=...               # or a gateway kvt_ token with
# export OPENROUTER_BASE_URL=https://gw-shinick.<account>.workers.dev/p/openrouter/api/v1
export TA_COURSES_DIR=courses
python -m ta_agent.cloudbite_cli --origin https://k.shinick.dev --course genai-101
```

The bot remembers sent replies in `~/.classroom-ta/cloudbite-bot-state.json` (outside the repo; override with
`TA_CLOUDBITE_STATE` or `--state`).

Verified with `tests/test_cloudbite.py` against an in-memory stand-in of the assistant API (scopes,
seat filtering, idempotent retries, 401/409 handling, reply length). Not verified against the real
Worker; run a dummy-lab round trip (ask → reply → learner resolves) before unattended use, as that
repo's `docs/classroom-assistants.md` requires.

## Known limits

- Rule patterns cover Korean and English only; a message in another language (French, Japanese, ...) is screened only by the system prompt and the optional LLM guard. There is no measured false-positive / false-negative rate; build an evaluation set from real class questions before tightening the patterns.
- The "discussion vs. request" heuristics (strong/weak educational words, procedure and step markers, quoted phrases, second-person addressing) are heuristics. A determined learner can still phrase a request so that it reads as a question; the LLM guard (`TA_GUARD_MODEL`) is the recommended second layer for courses where this matters.
- Leet-speak and spaced-letter folding covers simple cases (`1gn0re`, `i.g.n.o.r.e`), not arbitrary obfuscation or encodings such as base64.
- Output checks are string matches: a paraphrased answer key or a summarized prompt is not caught. Domain rules such as "no legal advice" live in the prompt and are not verified after the fact.
- The rate limiter is per process (no shared store). Behind a NAT, learners share an IP bucket unless the client sends `X-Session-Id`.
- The student token is shared, so individual learners are not identified; the crisis alert hook reports request ids, not people. In the cloudbite bot each log line carries both the question id and the agent's request id.
- The bot state file (`~/.classroom-ta/cloudbite-bot-state.json` by default) holds question ids and reply texts, no tokens.
- The `/chat` endpoint is synchronous; size the worker count to the expected concurrency.
- In the cloudbite channel a guardrail false positive is not recoverable: the canned refusal is the single final reply for that question and costs a write. Keep refusals rare (prefer caution notes) and review the `blocked` log lines after each class.
- The bot does not read grant or lab expiry; when the grant expires or the lab ends it stops with a log line. Run it under a supervisor and give it a fresh grant per class.

## Run

All commands run from this directory (inside the cloudbite repo that is `cd classroom-ta-agent`).

```bash
cd classroom-ta-agent
pip install -r requirements.txt
cp .env.example .env     # fill in values, then export them (e.g. `set -a; source .env; set +a`)

python -m ta_agent.cli --role student --course genai-101
uvicorn ta_agent.server:app --host 0.0.0.0 --port 8000
```

### API

`POST /chat` with `Authorization: Bearer <TA_STUDENT_TOKEN or TA_INSTRUCTOR_TOKEN>` and optional `X-Session-Id`.

```json
{
  "message": "What's the difference between a list and a tuple?",
  "course_id": "genai-101",
  "history": [
    {"role": "user", "content": "What is a variable?"},
    {"role": "assistant", "content": "A named place to store a value."}
  ]
}
```

Response:

```json
{"reply": "...", "blocked": false, "reason": null, "flags": ["hint_mode"], "role": "student",
 "course_id": "genai-101", "request_id": "3f2a9c1b7d4e"}
```

`blocked=true` means a guardrail refused; `reason` is one of `injection`, `self_harm`, `violence`, `illegal`,
`sexual`, `minor_unsafe`, `domain_block:<domain>`, `guard_block`, `system_prompt_leak`, `answer_key_leak`, ...
`reason="llm_error"` with `blocked=false` means the model call failed and a generic message was returned.

`GET /health` returns the loaded course ids.

## Tests

```bash
cd classroom-ta-agent
python -m pytest -q
```
