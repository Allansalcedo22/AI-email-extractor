"""Pydantic models for the extraction API.

`ExtractionResult` is the single source of truth for the shape of the LLM
output. It is passed to Gemini as `response_schema`, embedded in the OpenAI
prompt as a JSON Schema, and used to validate whatever comes back before it
reaches the client.
"""

from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, field_validator

MAX_INPUT_CHARS = 30_000


class Priority(str, Enum):
    HIGH = "HIGH"
    MEDIUM = "MEDIUM"
    LOW = "LOW"


class Tone(str, Enum):
    PROFESSIONAL = "Professional"
    CASUAL = "Casual"
    DIRECT = "Direct"


class ActionItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task: str = Field(description="Clear, actionable description starting with a verb.")
    owner: str = Field(
        description='Person responsible. "You" for a 1-on-1 message addressed to the reader; '
        '"Unassigned" if no owner can be determined.'
    )
    deadline: str = Field(
        description='Deadline as stated in the text (e.g. "Friday 5pm", "Mar 3"), '
        'or "No hard deadline".'
    )

    @field_validator("task", "owner", "deadline")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be blank")
        return v


class ExtractionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    priority: Priority = Field(description="Overall urgency of the message.")
    priority_reason: str = Field(description="One sentence explaining the priority.")
    is_group_thread: bool = Field(
        description="True if the message involves more than two people (multi-person thread, "
        "CC'd group, team announcement); false for a 1-on-1 message."
    )
    action_items: list[ActionItem] = Field(description="Concrete tasks found in the text.")
    questions_to_answer: list[str] = Field(
        description="Direct or implied questions the reader needs to reply to."
    )
    draft_reply: str = Field(
        description="Polite, ready-to-send reply. Uses bracketed placeholders such as "
        "[Insert Available Times] for any fact not present in the text."
    )


class ExtractRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=MAX_INPUT_CHARS)
    tone: Tone = Tone.PROFESSIONAL

    @field_validator("text")
    @classmethod
    def _has_content(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("text must contain non-whitespace characters")
        return v
