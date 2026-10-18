"""User-facing refusal / fallback messages, per reply language."""
from __future__ import annotations

MESSAGES: dict[str, dict[str, str]] = {
    "en": {
        "too_long": "Your message is too long. Please shorten it to {limit} characters or fewer.",
        "empty": "Please enter a question.",
        "injection": "Sorry, I can't help with that request. I'm happy to help with questions about the course.",
        "self_harm": (
            "It sounds like you're going through a hard time, and I'm concerned. Please don't face it alone: "
            "talk to someone you trust or to your instructor. For professional support you can contact {contacts}."
        ),
        "harmful": "Sorry, I can't help with that request. If you have a question about the course, I'm here.",
        "finance_illegal": "Sorry, I can't help with unfair trading or illegal financial activity.",
        "safety_bypass": (
            "I can't explain how to disable or bypass safety devices. If equipment seems faulty, stop work and "
            "report it to the site safety manager or equipment owner."
        ),
        "output_leak": "Sorry, I can't share that. Is there anything else about the course I can help with?",
        "answer_key": "I can't give out assessment answers, but I can explain the concepts and point you in the right direction.",
        "guard": "Sorry, I can't help with that request. If you have a question about the course, I'm here.",
        "llm_error": "I can't answer right now. Please try again in a moment or ask your instructor directly.",
        "truncated_suffix": "\n\n(The answer was cut off. Ask me to continue if you need the rest.)",
        "truncated_final": "\n\n(The answer was shortened to fit the help desk. Ask a follow-up question for the rest.)",
    },
    "ko": {
        "too_long": "질문이 너무 깁니다. 핵심만 {limit}자 이내로 줄여서 다시 질문해 주세요.",
        "empty": "질문 내용을 입력해 주세요.",
        "injection": "죄송하지만 그 요청은 도와드릴 수 없습니다. 강의 내용과 관련된 질문을 해 주시면 기꺼이 도와드릴게요.",
        "self_harm": (
            "많이 힘드신 것 같아 걱정됩니다. 혼자 견디지 마시고 주변에 믿을 수 있는 분이나 강사님께 이야기해 주세요. "
            "전문 상담이 필요하시면 {contacts}로 연락하실 수 있습니다."
        ),
        "harmful": "죄송하지만 그 요청은 도와드릴 수 없습니다. 강의와 관련된 질문이 있으시면 말씀해 주세요.",
        "finance_illegal": "죄송하지만 불공정 거래나 불법 금융 행위에 관한 내용은 도와드릴 수 없습니다.",
        "safety_bypass": (
            "안전장치를 해제하거나 우회하는 방법은 안내해 드릴 수 없습니다. 설비 이상이 있다면 작업을 멈추고 "
            "현장 안전관리자나 설비 담당자에게 알려 주세요."
        ),
        "output_leak": "죄송합니다. 그 내용은 답변드릴 수 없습니다. 다른 질문이 있으시면 말씀해 주세요.",
        "answer_key": "평가 정답은 직접 알려드릴 수 없어요. 대신 관련 개념이나 풀이 방향에 대한 힌트는 드릴 수 있습니다.",
        "guard": "죄송하지만 그 요청은 도와드릴 수 없습니다. 강의와 관련된 질문이 있으시면 말씀해 주세요.",
        "llm_error": "지금은 답변을 드리기 어렵습니다. 잠시 후 다시 시도하시거나 강사님께 직접 문의해 주세요.",
        "truncated_suffix": "\n\n(답변이 중간에 잘렸습니다. 이어서 듣고 싶으시면 '계속'이라고 말씀해 주세요.)",
        "truncated_final": "\n\n(도움 요청 답변 길이 제한으로 답변을 줄였습니다. 이어지는 내용은 새 질문으로 물어봐 주세요.)",
    },
}

# Crisis contacts are written in English in the domain profiles; translate for Korean replies.
CONTACTS_KO = {
    "the Korea suicide prevention line 109 (24h) or the mental-health crisis line 1577-0199": "자살예방상담전화 109(24시간) 또는 정신건강위기상담 1577-0199",
    "the Korea youth counseling line 1388 (24h) or the suicide prevention line 109 (24h)": "청소년상담전화 1388(24시간) 또는 자살예방상담전화 109(24시간)",
}


def msg(language: str, key: str, **kwargs: object) -> str:
    table = MESSAGES.get(language, MESSAGES["en"])
    if language == "ko" and "contacts" in kwargs:
        kwargs["contacts"] = CONTACTS_KO.get(str(kwargs["contacts"]), kwargs["contacts"])
    return table[key].format(**kwargs)
