"""The offline mock provider should give sensible output on both sample inputs."""

import asyncio

from ai_service import MockProvider
from schemas import Priority, Tone


def run(text, tone=Tone.PROFESSIONAL):
    return asyncio.run(MockProvider().extract(text, tone))


def test_group_email(group_email):
    r = run(group_email)
    assert r.is_group_thread is True
    assert r.priority is Priority.HIGH  # "urgent"
    owners = {i.owner for i in r.action_items}
    assert "Marcus" in owners and "Jen" in owners
    marcus = next(i for i in r.action_items if i.owner == "Marcus")
    assert "Thursday EOD" in marcus.deadline
    assert any("Oct 14" in q for q in r.questions_to_answer)
    assert "[Your Name]" in r.draft_reply


def test_one_on_one(one_on_one):
    r = run(one_on_one, Tone.CASUAL)
    assert r.is_group_thread is False
    assert r.action_items
    assert all(i.owner == "You" for i in r.action_items)
    assert any("Monday" in i.deadline for i in r.action_items)
    assert r.questions_to_answer
    assert r.draft_reply.startswith("Hey")


def test_informational_message_is_low():
    r = run("FYI the office will be closed for the holiday. Enjoy the long weekend")
    assert r.priority is Priority.LOW
    assert r.action_items == []
