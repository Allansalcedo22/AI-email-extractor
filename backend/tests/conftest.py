from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ai_service import ExtractionError, LLMProvider
from main import app, provider_dependency
from schemas import ExtractionResult, Tone

SAMPLES = Path(__file__).resolve().parent.parent / "samples"


@pytest.fixture
def group_email() -> str:
    return (SAMPLES / "group_email.txt").read_text()


@pytest.fixture
def one_on_one() -> str:
    return (SAMPLES / "one_on_one.txt").read_text()


class FakeProvider(LLMProvider):
    """Returns a canned result and records what it was called with."""

    name = "fake"
    model = "fake-1"

    def __init__(self, result: ExtractionResult | None = None, error: Exception | None = None):
        self.result = result
        self.error = error
        self.calls: list[tuple[str, Tone]] = []

    async def extract(self, text: str, tone: Tone) -> ExtractionResult:
        self.calls.append((text, tone))
        if self.error:
            raise self.error
        assert self.result is not None
        return self.result


@pytest.fixture
def make_client():
    def _make(provider: LLMProvider) -> TestClient:
        app.dependency_overrides[provider_dependency] = lambda: provider
        return TestClient(app)

    yield _make
    app.dependency_overrides.clear()


__all__ = ["FakeProvider", "ExtractionError"]
