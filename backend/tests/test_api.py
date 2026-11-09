import pytest

from ai_service import ExtractionError, build_user_prompt
from schemas import ActionItem, ExtractionResult, Priority, Tone
from tests.conftest import FakeProvider

GROUP_RESULT = ExtractionResult(
    priority=Priority.HIGH,
    priority_reason="The analytics dashboard is broken ahead of Friday's exec review.",
    is_group_thread=True,
    action_items=[
        ActionItem(task="Finalize landing page copy and send to legal", owner="Marcus", deadline="Thursday EOD"),
        ActionItem(task="Update the pricing table in Figma", owner="Jen", deadline="No hard deadline"),
        ActionItem(task="Book the photographer for the product shoot", owner="Unassigned", deadline="No hard deadline"),
        ActionItem(task="Fix the analytics dashboard", owner="Unassigned", deadline="Friday at 10am"),
    ],
    questions_to_answer=["Is the launch still Oct 14?"],
    draft_reply="Hi Priya,\n\nThanks for the recap. [Insert Launch Date Info]\n\n[Your Name]",
)

ONE_ON_ONE_RESULT = ExtractionResult(
    priority=Priority.MEDIUM,
    priority_reason="A proposal is due Monday, giving a few days of lead time.",
    is_group_thread=False,
    action_items=[
        ActionItem(task="Write a one-page proposal", owner="You", deadline="Monday"),
        ActionItem(task="Send updated resume", owner="You", deadline="No hard deadline"),
    ],
    questions_to_answer=["Are you free for a call Thursday afternoon?", "Are you OK being onsite two days a week?"],
    draft_reply="Hey! Thanks so much. I'll have the proposal to you by Monday. [Insert Availability]\n\n[Your Name]",
)


def test_health_reports_provider(monkeypatch):
    from fastapi.testclient import TestClient

    import ai_service
    from main import app

    monkeypatch.setenv("LLM_PROVIDER", "mock")
    ai_service.get_provider.cache_clear()
    try:
        body = TestClient(app).get("/api/health").json()
    finally:
        ai_service.get_provider.cache_clear()
    assert body == {"status": "ok", "provider": "mock", "model": "heuristic"}


@pytest.mark.parametrize(
    "fixture_name, result",
    [("group_email", GROUP_RESULT), ("one_on_one", ONE_ON_ONE_RESULT)],
)
def test_extract_returns_schema(request, make_client, fixture_name, result):
    text = request.getfixturevalue(fixture_name)
    provider = FakeProvider(result)
    resp = make_client(provider).post("/api/extract", json={"text": text, "tone": "Casual"})

    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {
        "priority", "priority_reason", "is_group_thread",
        "action_items", "questions_to_answer", "draft_reply",
    }
    assert body["priority"] in {"HIGH", "MEDIUM", "LOW"}
    assert body["is_group_thread"] is result.is_group_thread
    assert provider.calls == [(text.strip(), Tone.CASUAL)]


def test_tone_defaults_to_professional(make_client):
    provider = FakeProvider(ONE_ON_ONE_RESULT)
    make_client(provider).post("/api/extract", json={"text": "hi, can you call me?"})
    assert provider.calls[0][1] is Tone.PROFESSIONAL


@pytest.mark.parametrize(
    "payload",
    [{}, {"text": ""}, {"text": "   "}, {"text": "hi", "tone": "Angry"}, {"text": "hi", "foo": 1}],
)
def test_extract_validation_errors(make_client, payload):
    provider = FakeProvider(ONE_ON_ONE_RESULT)
    resp = make_client(provider).post("/api/extract", json=payload)
    assert resp.status_code == 422
    assert provider.calls == []


def test_provider_failure_is_502(make_client):
    provider = FakeProvider(error=ExtractionError("model returned junk"))
    resp = make_client(provider).post("/api/extract", json={"text": "hello"})
    assert resp.status_code == 502
    assert "junk" in resp.json()["detail"]


def test_missing_api_key_is_503(monkeypatch):
    from fastapi.testclient import TestClient

    import ai_service
    from main import app

    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    ai_service.get_provider.cache_clear()
    try:
        resp = TestClient(app).post("/api/extract", json={"text": "hello"})
    finally:
        ai_service.get_provider.cache_clear()
    assert resp.status_code == 503
    assert "GEMINI_API_KEY" in resp.json()["detail"]


def test_cors_allows_chrome_extension(make_client):
    client = make_client(FakeProvider(ONE_ON_ONE_RESULT))
    origin = "chrome-extension://" + "a" * 32
    resp = client.options(
        "/api/extract",
        headers={"Origin": origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"},
    )
    assert resp.headers.get("access-control-allow-origin") == origin

    resp = client.options(
        "/api/extract",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"},
    )
    assert "access-control-allow-origin" not in resp.headers


def test_prompt_contains_tone_and_text():
    prompt = build_user_prompt("Please send the deck.", Tone.DIRECT)
    assert "Direct" in prompt
    assert "Please send the deck." in prompt


def test_samples_endpoint(make_client, group_email, one_on_one):
    body = make_client(FakeProvider(ONE_ON_ONE_RESULT)).get("/api/samples").json()
    assert body == {"group_email": group_email, "one_on_one": one_on_one}


def test_root_serves_demo_page(make_client):
    client = make_client(FakeProvider(ONE_ON_ONE_RESULT))
    resp = client.get("/")
    assert resp.status_code == 200
    assert "<title>" in resp.text
