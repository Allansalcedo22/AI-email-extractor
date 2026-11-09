"""Calls the real configured LLM. Skipped by default.

    LLM_PROVIDER=gemini GEMINI_API_KEY=... pytest -m live -v

The draft-reply checks are heuristics: they look at the reply text OUTSIDE
bracketed placeholders for answers or commitments the reader never made.
"""

import asyncio
import re

import pytest

from ai_service import ProviderConfigError, get_provider
from schemas import Tone

pytestmark = pytest.mark.live

PLACEHOLDER = re.compile(r"\[[^\]]+\]")


def placeholders(reply: str) -> list[str]:
    """Bracketed placeholders other than the sign-off / greeting ones."""
    return [p for p in PLACEHOLDER.findall(reply) if p.lower() not in {"[your name]", "[recipient name]"}]


def outside_brackets(reply: str) -> str:
    return PLACEHOLDER.sub(" ", reply).lower()


@pytest.fixture
def provider():
    # Fresh client per test: each asyncio.run() uses a new event loop, and async
    # HTTP clients can't be reused across loops.
    get_provider.cache_clear()
    try:
        p = get_provider()
    except ProviderConfigError as exc:
        pytest.skip(str(exc))
    if p.name == "mock":
        pytest.skip("live tests need a real provider")
    return p


def test_live_group_email(provider, group_email):
    r = asyncio.run(provider.extract(group_email, Tone.PROFESSIONAL))
    assert r.is_group_thread is True
    assert r.priority.value in {"HIGH", "MEDIUM"}
    owners = {i.owner.lower() for i in r.action_items}
    assert any("marcus" in o for o in owners)
    assert any("jen" in o for o in owners)
    assert r.questions_to_answer

    reply = r.draft_reply
    text = outside_brackets(reply)
    assert placeholders(reply), f"reply needs placeholders for unknowns:\n{reply}"
    # Reader is not Priya: must not hand out her instructions again.
    assert not re.search(r"\b(marcus|jen|dan)\s*,", text), reply
    # "Dan, any update?" is Dan's question, not the reader's.
    assert not any(q.lower().startswith("dan") for q in r.questions_to_answer), r.questions_to_answer
    # Must not volunteer the reader for the unassigned dashboard fix.
    assert not re.search(r"\bi(?:'ll| will)\b[^.]*\bdashboard\b", text), reply


def test_live_one_on_one(provider, one_on_one):
    r = asyncio.run(provider.extract(one_on_one, Tone.CASUAL))
    assert r.is_group_thread is False
    assert len(r.action_items) >= 2
    assert any(i.owner == "You" for i in r.action_items)
    assert any("monday" in i.deadline.lower() for i in r.action_items)
    assert len(r.questions_to_answer) >= 2

    reply = r.draft_reply
    text = outside_brackets(reply)
    assert len(placeholders(reply)) >= len(r.questions_to_answer), (
        f"expected a placeholder per question ({len(r.questions_to_answer)}):\n{reply}"
    )
    # The reader never said whether they're free or OK with onsite work.
    fabricated = re.compile(
        r"\bi(?:'m|’m| am)\s+(?:totally\s+|definitely\s+|also\s+)?"
        r"(?:free|available|okay|ok|fine|good|happy)\b"
    )
    assert not fabricated.search(text), f"reply answers for the reader:\n{reply}"
