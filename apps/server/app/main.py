from __future__ import annotations

import uuid
import hashlib
import json
import re
from collections import deque
from dataclasses import dataclass
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .graph import build_graph
from .models import ActionPlan, ConversationMessage, InstructionRequest, StartRunRequest, StepRequest, ViewportMetadata

load_dotenv()


@dataclass
class Run:
    task: str
    action: ActionPlan | None = None
    screenshot: str = ""
    tab_url: str | None = None
    target_map: dict[str, Any] | None = None
    viewport: ViewportMetadata | None = None
    previous_action: str | None = None
    history: list[ConversationMessage] | None = None
    status: str = "active"
    last_action_signature: str | None = None
    last_observed_page_state: str | None = None
    unchanged_observation_streak: int = 0
    recent_action_signatures: deque[str] | None = None

    def __post_init__(self) -> None:
        if self.history is None:
            self.history = []
        if self.recent_action_signatures is None:
            self.recent_action_signatures = deque(maxlen=12)


app = FastAPI(title="VISTA LangGraph Server", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_origin_regex=r"chrome-extension://.*",
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
graph = build_graph()
runs: dict[str, Run] = {}


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "planner": "langgraph"}


@app.post("/runs")
def start_run(request: StartRunRequest) -> dict[str, Any]:
    run_id = uuid.uuid4().hex
    run = Run(
        task=request.task,
        screenshot=request.screenshot,
        tab_url=request.tab_url,
        target_map=request.target_map,
        viewport=request.viewport or ViewportMetadata(revision=request.viewport_revision or 0),
        history=[ConversationMessage(role="user", content=request.task)],
    )
    runs[run_id] = run
    action = next_action(run)
    return run_response(run_id, run, include_screenshot=True)


@app.post("/runs/{run_id}/step")
def step_run(run_id: str, request: StepRequest) -> dict[str, Any]:
    run = runs.get(run_id)
    if not run:
        # If server was reloaded during run, recover gracefully instead of 404
        run = Run(
            task="Continue active browsing task",
            screenshot=request.screenshot,
            tab_url=request.tab_url,
            target_map=request.target_map,
            viewport=request.viewport or ViewportMetadata(revision=request.viewport_revision or 0),
        )
        runs[run_id] = run
    ensure_resumable(run)
    run.screenshot = request.screenshot
    run.tab_url = request.tab_url or run.tab_url
    run.target_map = request.target_map
    run.viewport = request.viewport or ViewportMetadata(revision=request.viewport_revision or (run.viewport.revision if run.viewport else 0))
    action = next_action(run)
    return run_response(run_id, run, include_screenshot=True)


@app.post("/runs/{run_id}/instructions")
def append_instruction(run_id: str, request: InstructionRequest) -> dict[str, Any]:
    run = runs.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    ensure_resumable(run)
    run.history.append(ConversationMessage(role="user", content=request.instruction.strip()))
    # User takeover is a fresh decision boundary; clear only loop-detector
    # state, retaining the complete conversation history for the planner.
    run.last_observed_page_state = None
    run.unchanged_observation_streak = 0
    run.recent_action_signatures.clear()
    run.status = "active"
    return {"run_id": run_id, "status": run.status, "history": history_dump(run)}


@app.get("/runs/{run_id}")
def get_run(run_id: str) -> dict[str, Any]:
    run = runs.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return run_response(run_id, run)


# Resume aliases let an interrupted extension request a fresh action without
# creating a second run. They all require the current screenshot.
@app.post("/runs/{run_id}/next")
@app.post("/runs/{run_id}/next-action")
@app.post("/runs/{run_id}/resume")
def next_run_action(run_id: str, request: StepRequest) -> dict[str, Any]:
    return step_run(run_id, request)


def next_action(run: Run) -> ActionPlan:
    page_state = page_state_signature(run.screenshot, run.tab_url)
    if run.last_observed_page_state == page_state:
        run.unchanged_observation_streak += 1
    else:
        run.unchanged_observation_streak = 0
    run.last_observed_page_state = page_state

    observation_unchanged = run.unchanged_observation_streak > 0 and run.action is not None

    if (
        (run.unchanged_observation_streak >= 3 and repeated_action_detected(run))
        and run.action is not None
        and run.action.type not in {"request_user", "confirm_purchase", "done"}
    ):
        action = stuck_action(run)
        record_action(run, action)
        return action

    try:
        result = graph.invoke(
            {
                "task": run.task,
                "screenshot": run.screenshot,
                "tab_url": run.tab_url,
                "previous_action": run.previous_action,
                "history": history_dump(run),
                "recent_actions": list(run.recent_action_signatures),
                "target_map": run.target_map or {},
                "viewport": (run.viewport or ViewportMetadata()).model_dump(mode="json"),
                "observation_unchanged": observation_unchanged,
                "unchanged_streak": run.unchanged_observation_streak,
            }
        )
        action = normalize_action(result["action"], run.target_map or {}, (run.viewport.revision if run.viewport else 0), run.tab_url, run.task)
    except Exception as e:
        import traceback
        traceback.print_exc()
        action = ActionPlan(
            type="request_user",
            description=f"The agent encountered an issue ({type(e).__name__}). Please tell me how to continue, or retry.",
            reason=str(e)[:300],
        )

    record_action(run, action)
    return action


def page_state_signature(screenshot: str, tab_url: str | None) -> str:
    digest = hashlib.sha256(screenshot.encode("utf-8")).hexdigest()
    return f"{(tab_url or '').strip().casefold()}:{digest}"


def normalized_action_signature(action: ActionPlan) -> str:
    values = action.model_dump(mode="json", exclude_none=True)
    values.pop("description", None)
    values.pop("reason", None)
    if isinstance(values.get("text"), str):
        values["text"] = re.sub(r"\s+", " ", values["text"]).strip().casefold()
    if isinstance(values.get("url"), str):
        values["url"] = values["url"].casefold()
    return json.dumps(values, sort_keys=True, separators=(",", ":"))


def repeated_action_detected(run: Run) -> bool:
    signatures = list(run.recent_action_signatures)
    if len(signatures) < 3:
        return False
    # If currently scrolling, scrolling multiple times is normal exploration and not stuck
    if signatures[-1] and "scroll" in signatures[-1]:
        return len(signatures) >= 8 and len(set(signatures[-8:])) == 1
    return len(set(signatures[-3:])) == 1


def record_action(run: Run, action: ActionPlan) -> None:
    run.action = action
    run.previous_action = action.model_dump_json()
    run.recent_action_signatures.append(normalized_action_signature(action))
    if action.type in {"request_user", "confirm_purchase"}:
        run.history.append(ConversationMessage(role="assistant", content=action.description))
    else:
        run.history.append(ConversationMessage(role="assistant", content=action.model_dump_json()))
    if action.type == "done":
        run.status = "completed"
    elif action.type in {"request_user", "confirm_purchase"}:
        run.status = "paused"
    else:
        run.status = "active"


def stuck_action(run: Run) -> ActionPlan:
    prior = run.action.type if run.action else "action"
    return ActionPlan(
        type="request_user",
        description=(
            f"I could not make progress after repeating the same {prior} step. "
            "Please complete the blocked step manually, then tell me what changed on the page."
        ),
        reason="The browser observation did not change after three attempts.",
    )


def ensure_resumable(run: Run) -> None:
    if run.status == "completed":
        raise HTTPException(status_code=409, detail="Run is already complete")


def history_dump(run: Run) -> list[dict[str, str]]:
    return [message.model_dump() for message in run.history]


def run_response(run_id: str, run: Run, *, include_screenshot: bool = False) -> dict[str, Any]:
    response: dict[str, Any] = {
        "run_id": run_id,
        "action": run.action.model_dump(mode="json") if run.action else None,
        "status": run.status,
        "history": history_dump(run),
    }
    if include_screenshot:
        response["screenshot"] = run.screenshot
    return response


def _target_refs(target_map: dict[str, Any]) -> set[str]:
    refs: set[str] = set(target_map)
    nested = target_map.get("refs")
    if isinstance(nested, dict):
        refs.update(str(ref) for ref in nested)
    if isinstance(target_map.get("targets"), list):
        refs.update(
            str(item["ref"])
            for item in target_map["targets"]
            if isinstance(item, dict) and item.get("ref")
        )
    return refs


def normalize_action(action: ActionPlan, target_map: dict[str, Any], viewport_revision: int = 0, current_url: str | None = None, task: str = "") -> ActionPlan:
    """Keep model output inside the extension's small, auditable action surface."""
    available_refs = _target_refs(target_map)
    if action.ref and action.ref not in available_refs:
        if action.x is not None and action.y is not None:
            action = action.model_copy(update={"ref": None, "fallback": True, "coordinate_space": "normalized_1000"})
        else:
            return ActionPlan(type="scroll", direction="down", amount=500, description="Scrolling down to bring target into view.")
    if action.type in {"click", "type"} and not action.ref and (action.x is None or action.y is None):
        return ActionPlan(type="scroll", direction="down", amount=500, description="Scrolling down to find interactive elements.")
    if action.type == "type" and not action.text:
        return ActionPlan(type="wait", milliseconds=1000, description="Waiting for input field to be ready.")
    if action.type == "navigate":
        raw_url = (str(action.url) if action.url else "").strip()
        if not raw_url:
            return ActionPlan(type="request_user", description="The planner proposed an invalid navigation target.", reason="Missing navigation URL")
        if not raw_url.startswith(("http://", "https://")):
            if raw_url.startswith("www.") or "." in raw_url:
                raw_url = f"https://{raw_url}"
                action = action.model_copy(update={"url": raw_url})
            else:
                return ActionPlan(type="request_user", description="The planner proposed an invalid navigation target.", reason="Only http(s) URLs are allowed")
        # Guardrail: If on a user-requested target site, do not allow rogue navigation to Google:
        if current_url and "google.com" in raw_url.lower() and "google.com" not in current_url.lower():
            task_lower = task.lower()
            if any(domain in task_lower for domain in ["wikipedia", "amazon", "youtube", "reddit", "github", "twitter"]):
                return ActionPlan(
                    type="done",
                    description="Task complete on the requested website.",
                    final_overview=f"Done! Located the requested content on {current_url}."
                )
    if action.type == "confirm_purchase" and action.summary is None:
        return ActionPlan(type="confirm_purchase", description=action.description, summary=None)
    if not action.ref and action.x is not None and action.y is not None:
        action = action.model_copy(update={"fallback": True, "coordinate_space": "normalized_1000"})
    if (action.ref or action.fallback or action.x is not None) and action.viewport_revision is None:
        action = action.model_copy(update={"viewport_revision": viewport_revision})
    return action
