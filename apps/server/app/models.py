from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, HttpUrl


ActionType = Literal[
    "click",
    "type",
    "scroll",
    "navigate",
    "wait",
    "request_user",
    "confirm_purchase",
    "done",
]

ConversationRole = Literal["user", "assistant"]


class PurchaseSummary(BaseModel):
    merchant: Optional[str] = None
    item: Optional[str] = None
    total: Optional[str] = None
    currency: Optional[str] = None


class ViewportMetadata(BaseModel):
    width: int = Field(default=1000, gt=0, le=10000)
    height: int = Field(default=1000, gt=0, le=10000)
    device_pixel_ratio: float = Field(default=1, gt=0, le=10)
    revision: int = Field(default=0, ge=0)


class ActionPlan(BaseModel):
    type: ActionType
    description: str = Field(min_length=1, max_length=500)
    # Coordinates are deliberately normalized so a screenshot and the live
    # viewport can use the same action shape. The extension converts them to
    # CSS pixels immediately before execution.
    x: Optional[int] = Field(default=None, ge=0, le=1000)
    y: Optional[int] = Field(default=None, ge=0, le=1000)
    ref: Optional[str] = Field(default=None, min_length=1, max_length=200)
    target_hint: Optional[str] = Field(default=None, max_length=500)
    coordinate_space: Optional[Literal["normalized_1000"]] = None
    viewport_revision: Optional[int] = Field(default=None, ge=0)
    fallback: bool = False
    text: Optional[str] = Field(default=None, max_length=1000)
    direction: Optional[Literal["up", "down"]] = None
    amount: Optional[int] = Field(default=600, ge=100, le=1500)
    url: Optional[str] = Field(default=None, max_length=2000)
    press_enter: Optional[bool] = False
    milliseconds: Optional[int] = Field(default=1000, ge=100, le=5000)
    reason: Optional[str] = Field(default=None, max_length=500)
    final_overview: Optional[str] = Field(default=None, max_length=1500)
    summary: Optional[Any] = None


class ConversationMessage(BaseModel):
    """A task/action turn retained for the lifetime of a run."""

    role: ConversationRole
    content: str = Field(min_length=1, max_length=5000)


class StartRunRequest(BaseModel):
    task: str = Field(min_length=2, max_length=4000)
    screenshot: str = Field(min_length=32)
    tab_url: Optional[str] = None
    target_map: dict[str, Any] = Field(default_factory=dict)
    viewport: Optional[ViewportMetadata] = None
    viewport_revision: Optional[int] = Field(default=None, ge=0)


class StepRequest(BaseModel):
    screenshot: str = Field(min_length=32)
    tab_url: Optional[str] = None
    target_map: dict[str, Any] = Field(default_factory=dict)
    viewport: Optional[ViewportMetadata] = None
    viewport_revision: Optional[int] = Field(default=None, ge=0)


class InstructionRequest(BaseModel):
    instruction: str = Field(min_length=1, max_length=4000)
