import pytest
from fastapi.testclient import TestClient

from ta_agent.agent import TeachingAssistant
from ta_agent.config import CourseInfo, Settings
from ta_agent.llm import Completion

INST = "instructor-token-0123456789"
STUD = "student-token-0123456789ab"


class Echo:
    def complete(self, messages, **overrides):
        return Completion(text="answer", finish_reason="stop")


def make_client(monkeypatch, courses=None, **env):
    monkeypatch.setenv("TA_INSTRUCTOR_TOKEN", INST)
    monkeypatch.setenv("TA_STUDENT_TOKEN", STUD)
    monkeypatch.setenv("TA_RATE_LIMIT_PER_MIN", "3")
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    from ta_agent.server import create_app
    courses = courses or {"c1": CourseInfo(id="c1")}
    ta = TeachingAssistant(Settings(api_key="t", courses=courses), model=Echo())
    return TestClient(create_app(ta))


@pytest.fixture
def client(monkeypatch):
    return make_client(monkeypatch)


def test_requires_token(client):
    assert client.post("/chat", json={"message": "hi"}).status_code == 401
    assert client.post("/chat", json={"message": "hi"}, headers={"Authorization": "Bearer nope"}).status_code == 401


def test_role_from_token(client):
    r = client.post("/chat", json={"message": "hello"}, headers={"Authorization": f"Bearer {INST}"})
    assert r.status_code == 200 and r.json()["role"] == "instructor" and r.json()["request_id"]
    r = client.post("/chat", json={"message": "hello"}, headers={"Authorization": f"Bearer {STUD}"})
    assert r.json()["role"] == "student"


def test_rate_limit(client):
    h = {"Authorization": f"Bearer {STUD}"}
    codes = [client.post("/chat", json={"message": "hello"}, headers=h).status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]


def test_rate_limit_separates_sessions(client):
    h = {"Authorization": f"Bearer {STUD}", "X-Session-Id": "a"}
    for _ in range(3):
        client.post("/chat", json={"message": "hello"}, headers=h)
    assert client.post("/chat", json={"message": "hello"}, headers=h).status_code == 429
    assert client.post("/chat", json={"message": "hello"}, headers={**h, "X-Session-Id": "b"}).status_code == 200


def test_failed_auth_attempts_rate_limited_but_valid_ones_not(monkeypatch):
    client = make_client(monkeypatch, TA_AUTH_FAIL_LIMIT_PER_MIN="2", TA_RATE_LIMIT_PER_MIN="50")
    ok = {"Authorization": f"Bearer {STUD}"}
    assert [client.post("/chat", json={"message": "x"}, headers=ok).status_code for _ in range(5)] == [200] * 5
    codes = [client.post("/chat", json={"message": "x"}, headers={"Authorization": "Bearer bad"}).status_code for _ in range(3)]
    assert codes == [401, 401, 429]
    assert client.post("/chat", json={"message": "x"}, headers=ok).status_code == 429  # locked out with the others


def test_session_rotation_bounded_by_ip_limit(monkeypatch):
    client = make_client(monkeypatch, TA_RATE_LIMIT_PER_IP_PER_MIN="4")
    codes = [client.post("/chat", json={"message": "x"}, headers={"Authorization": f"Bearer {STUD}", "X-Session-Id": str(i)}).status_code for i in range(5)]
    assert codes == [200, 200, 200, 200, 429]


def test_forwarded_for_uses_proxy_appended_entry(monkeypatch):
    client = make_client(monkeypatch, TA_TRUST_PROXY="1", TA_RATE_LIMIT_PER_IP_PER_MIN="2")
    h = {"Authorization": f"Bearer {STUD}"}
    for spoof in ("1.1.1.1", "2.2.2.2", "3.3.3.3"):
        r = client.post("/chat", json={"message": "x"}, headers={**h, "X-Forwarded-For": f"{spoof}, 9.9.9.9"})
    assert r.status_code == 429  # all three count against 9.9.9.9


def test_same_or_short_tokens_rejected(monkeypatch):
    from ta_agent.server import create_app
    monkeypatch.setenv("TA_INSTRUCTOR_TOKEN", INST)
    monkeypatch.setenv("TA_STUDENT_TOKEN", INST)
    with pytest.raises(RuntimeError):
        create_app()
    monkeypatch.setenv("TA_STUDENT_TOKEN", "short")
    with pytest.raises(RuntimeError):
        create_app()


def test_course_selection(monkeypatch):
    courses = {"ai": CourseInfo(id="ai", domain="ai"), "law": CourseInfo(id="law", domain="law")}
    client = make_client(monkeypatch, courses=courses)
    h = {"Authorization": f"Bearer {STUD}"}
    assert client.post("/chat", json={"message": "hi"}, headers=h).status_code == 400
    assert client.post("/chat", json={"message": "hi", "course_id": "nope"}, headers=h).status_code == 400
    r = client.post("/chat", json={"message": "hi", "course_id": "law"}, headers=h)
    assert r.status_code == 200 and r.json()["course_id"] == "law"
    assert client.get("/health").json() == {"status": "ok", "courses": 2}
