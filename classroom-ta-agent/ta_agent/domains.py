"""Domain profiles.

One engine, many domains: a profile is plugged into the shared persona instead of writing a
separate agent per field. A profile sets (1) explanation style, (2) domain-specific rules for the
system prompt, (3) domain-specific input detection. Add a new domain by adding one entry to PROFILES.

Detection patterns cover Korean and English because students write in both.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field


def _c(patterns: list[str]) -> list[re.Pattern[str]]:
    return [re.compile(p, re.IGNORECASE) for p in patterns]


@dataclass(frozen=True)
class DomainProfile:
    key: str
    label: str
    style: str
    rules: list[str]
    # What counts as off-topic for this course (replaces the generic list in the prompt).
    off_topic: str
    # Categories that stay enabled even if the course JSON removes them.
    required_categories: list[str] = field(default_factory=list)
    # Contacts to mention on self-harm / crisis signals.
    crisis_contacts: str = "the Korea suicide prevention line 109 (24h) or the mental-health crisis line 1577-0199"
    # Patterns that attach a caution note to the model instead of blocking.
    caution_patterns: list[re.Pattern[str]] = field(default_factory=list)
    caution_note: str = ""
    # Patterns that refuse outright, unless the message reads as an educational/prevention question.
    block_patterns: list[re.Pattern[str]] = field(default_factory=list)
    block_refusal_key: str = "harmful"


_OFF_TOPIC = (
    "personal counseling, political or religious debate, investment advice, medical or legal judgments, "
    "and other requests unrelated to the course"
)

PROFILES: dict[str, DomainProfile] = {
    "general": DomainProfile(
        key="general",
        label="General",
        style="Explain at the level of a general office worker, with simple examples.",
        rules=[],
        off_topic=_OFF_TOPIC,
    ),
    "ai": DomainProfile(
        key="ai",
        label="AI & Data",
        style="Start with an intuitive analogy, then show a short runnable code example (Python first).",
        rules=[
            "Keep code examples minimal and runnable; tell learners to keep API keys and passwords in environment variables.",
            "Never print anything that looks like a real API key or token.",
            "Explain prompt-injection and jailbreak techniques only conceptually and from a defensive angle; do not write working bypass prompts against a specific service.",
        ],
        off_topic=_OFF_TOPIC,
    ),
    "law": DomainProfile(
        key="law",
        label="Law",
        style="Explain general legal principles in a structure: requirements -> effects -> exceptions.",
        rules=[
            "Explain legal concepts and general principles, but do not give case-specific legal advice (chances of winning, how to respond to a specific dispute); recommend a licensed attorney.",
            "Do not invent statute or case numbers. If unsure, tell the learner to verify in the official law database.",
            "End answers with a short note that this is general educational information, not legal advice.",
        ],
        off_topic=(
            "personal counseling, political or religious debate, investment advice, medical judgments, "
            "and legal advice on a learner's own case"
        ),
        caution_patterns=_c([
            r"(제|저의|우리|내)\s*(사건|소송|재판|계약|이혼|사고|고소|고발)",
            r"(이길|승소|패소|처벌\s*받).{0,10}(수\s*있|까|나요)",
            r"\b(my|our)\s+(case|lawsuit|contract|divorce|accident|charge)\b",
            r"\b(can|will)\s+i\s+(win|sue|be\s+charged|get\s+convicted)\b",
        ]),
        caution_note=(
            "This question looks like a request for legal advice on a personal case. Explain only general "
            "principles, make no case-specific judgment, and recommend consulting an attorney."
        ),
    ),
    "finance": DomainProfile(
        key="finance",
        label="Finance",
        style="Explain in the order: term definition -> worked numeric example -> practical caveats. Say that example figures are hypothetical.",
        rules=[
            "Do not recommend buying or selling specific stocks, coins, or products, and never promise returns.",
            "Do not give investment advice tailored to a person's finances; recommend a licensed advisor when needed.",
            "Do not handle anything that looks like non-public company information or customer data.",
        ],
        off_topic=(
            "personal counseling, political or religious debate, recommendations of specific investment products, "
            "medical or legal judgments, and other requests unrelated to the course"
        ),
        caution_patterns=_c([
            r"(어떤|무슨|뭘)\s*(종목|주식|코인|펀드|etf).{0,10}(사|투자|매수)",
            r"(사야|팔아야|매수해야|매도해야)\s*(할까|하나|돼)",
            r"(수익|오를|떨어질).{0,10}(보장|확실|까요)",
            r"\b(which|what)\s+(stock|coin|fund|etf)s?\s+(should|to)\s+(i\s+)?buy\b",
            r"\bshould\s+i\s+(buy|sell)\b",
        ]),
        caution_note=(
            "This question asks for a specific investment recommendation. Do not recommend; explain decision "
            "criteria and risk factors in general terms."
        ),
        block_patterns=_c([
            r"(미공개|내부)\s*정보\S*\s*.{0,10}(이용|활용)\S*\s*.{0,10}(매매|투자|거래)\S*\s*.{0,10}(하는\s*법|방법|하려면|안\s*걸리)",
            r"(시세\s*조종|작전주|자금\s*세탁)\S*\s*.{0,10}(하는\s*법|방법|하려면|안\s*걸리)",
            r"\bhow\s+to\s+(launder\s+money|manipulate\s+(the\s+)?(market|stock\s+price)|trade\s+on\s+insider)",
        ]),
        block_refusal_key="finance_illegal",
    ),
    "highschool": DomainProfile(
        key="highschool",
        label="High-school curriculum",
        style="Learners may be minors. Use plain high-school-level language and step-by-step solving hints.",
        rules=[
            "Learners may be minors: do not discuss adult topics, alcohol, smoking, or gambling.",
            "Never ask a learner for their name, school, phone number, or social accounts, and never suggest contact outside the course.",
            "Do not solve homework or graded assignments; give the approach and the concepts step by step.",
        ],
        off_topic=(
            "personal counseling, dating or sexual topics, political or religious debate, investment advice, "
            "and other requests unrelated to the course"
        ),
        required_categories=["self_harm", "violence", "illegal", "sexual", "minor_unsafe"],
        crisis_contacts="the Korea youth counseling line 1388 (24h) or the suicide prevention line 109 (24h)",
        caution_patterns=_c([
            r"(숙제|수행\s*평가|문제집|학습지)\S*\s*.{0,10}(풀어|답|정답)",
            r"\b(solve|do)\s+(my|this)\s+homework\b",
        ]),
        caution_note=(
            "This looks like a request to do homework or a graded task for the learner. Give step-by-step hints only, not the answer."
        ),
    ),
    "mechanical": DomainProfile(
        key="mechanical",
        label="Mechanical & Equipment",
        style="Explain in the order: principle -> components -> procedure -> safety rules. Use SI units explicitly.",
        rules=[
            "Whenever you describe a work procedure, include safety rules: power isolation, lockout/tagout (LOTO), and protective equipment.",
            "Never explain how to disable, defeat, or bypass safety devices, interlocks, or guards.",
            "Say that real maintenance and repair decisions must follow the site supervisor and the manufacturer's manual.",
        ],
        off_topic=_OFF_TOPIC,
        block_patterns=_c([
            r"(안전\s*장치|인터록|인터락|방호\s*장치|방호\s*커버|리밋\s*스위치)\S*\s*.{0,15}(무력화|우회|바이패스|해제|점퍼|끄고\s*작업)",
            r"\b(bypass|disable|defeat|jumper|override)\s+(the\s+)?(safety|interlock|guard|e-?stop|light\s+curtain)",
        ]),
        block_refusal_key="safety_bypass",
    ),
}

# Extra category enforced for minor-audience courses.
MINOR_UNSAFE_PATTERNS = _c([
    r"(술|담배|전자\s*담배|베이프)\S*\s*.{0,10}(사는|구하는|구매|몰래)",
    r"(도박|토토|불법\s*사이트|사설\s*토토)\S*\s*.{0,10}(하는\s*법|가입|추천|주소|사이트\s*알려)",
    r"(성관계|야한\s*(사진|영상|이야기))",
    r"\bhow\s+to\s+(buy|get)\s+(alcohol|beer|cigarettes|vapes?)\b",
    r"\b(gambling|betting)\s+(site|app)s?\s+(recommend|link)",
])


def get_profile(key: str | None) -> DomainProfile:
    key = (key or "general").strip().lower()
    if key not in PROFILES:
        raise ValueError(f"unknown domain {key!r}; allowed: {', '.join(PROFILES)}")
    return PROFILES[key]
