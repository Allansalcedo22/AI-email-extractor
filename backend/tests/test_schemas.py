import pytest
from pydantic import ValidationError

from ai_service import _validate, ExtractionError
from schemas import MAX_INPUT_CHARS, ExtractionResult, ExtractRequest, Tone

VALID = {
    "priority": "HIGH",
    "priority_reason": "Deadline is tomorrow.",
    "is_group_thread": False,
    "action_items": [{"task": "Send resume", "owner": "You", "deadline": "Monday"}],
    "questions_to_answer": ["Are you free Thursday?"],
    "draft_reply": "Hi [Recipient Name], ... [Your Name]",
}


def test_valid_result_parses():
    r = ExtractionResult.model_validate(VALID)
    assert r.priority.value == "HIGH"
    assert r.action_items[0].owner == "You"


@pytest.mark.parametrize(
    "patch",
    [
        {"priority": "URGENT"},  # not in enum
        {"priority": "high"},  # enum is case-sensitive
        {"action_items": [{"task": "x", "owner": "You"}]},  # missing deadline
        {"action_items": [{"task": "   ", "owner": "You", "deadline": "Monday"}]},  # blank task
        {"extra_field": 1},  # extra keys forbidden
    ],
)
def test_invalid_results_rejected(patch):
    with pytest.raises(ValidationError):
        ExtractionResult.model_validate({**VALID, **patch})


def test_missing_field_rejected():
    data = dict(VALID)
    del data["draft_reply"]
    with pytest.raises(ValidationError):
        ExtractionResult.model_validate(data)


def test_request_defaults_and_strips():
    req = ExtractRequest(text="  hello  ")
    assert req.text == "hello"
    assert req.tone is Tone.PROFESSIONAL


@pytest.mark.parametrize("text", ["", "   \n\t "])
def test_request_rejects_empty(text):
    with pytest.raises(ValidationError):
        ExtractRequest(text=text)


def test_request_rejects_too_long():
    with pytest.raises(ValidationError):
        ExtractRequest(text="a" * (MAX_INPUT_CHARS + 1))


def test_validate_strips_code_fences():
    import json

    raw = "```json\n" + json.dumps(VALID) + "\n```"
    assert _validate(raw).priority_reason == VALID["priority_reason"]


def test_validate_raises_extraction_error_on_garbage():
    with pytest.raises(ExtractionError):
        _validate("Sure! Here are your action items: ...")
