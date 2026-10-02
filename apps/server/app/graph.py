from __future__ import annotations

import os
import threading
import json
import logging
from typing import Any, TypedDict

from dotenv import find_dotenv, load_dotenv
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.graph import END, START, StateGraph

from .models import ActionPlan

load_dotenv(find_dotenv(usecwd=True))
logger = logging.getLogger("agentbrow.graph")

FALLBACK_1X1_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg=="


def _normalize_screenshot(screenshot: str | None) -> str:
    if not screenshot or not isinstance(screenshot, str) or not screenshot.startswith("data:"):
        return FALLBACK_1X1_PNG
    try:
        header, b64_data = screenshot.split(",", 1)
        b64_data = b64_data.strip().replace("\n", "").replace("\r", "")
        missing_padding = len(b64_data) % 4
        if missing_padding:
            b64_data += "=" * (4 - missing_padding)
        return f"{header},{b64_data}"
    except Exception:
        return FALLBACK_1X1_PNG


class AgentState(TypedDict, total=False):
    task: str
    screenshot: str
    tab_url: str | None
    previous_action: str | None
    history: list[dict[str, str]]
    recent_actions: list[str]
    target_map: dict[str, Any]
    viewport: dict[str, Any]
    action: ActionPlan
    observation_unchanged: bool
    unchanged_streak: int


SYSTEM_PROMPT = """You are an autonomous browser agent. You control the browser to complete the user's task from start to finish.

You receive:
1. The user's task and conversation/action history.
2. The current tab URL and viewport info.
3. Sanitized Simplified Semantic HTML (authoritative ref="eX"): A clean, pruned semantic DOM tree (<main>, <nav>, <form>, <label>, <input ref="eX">, <button ref="eY">, etc.) with Set-of-Mark ref="eX" attributes, landmark hierarchy, and privacy-masked values.
4. The latest screenshot of the active browser tab.

CRITICAL COMPLETION DIRECTIVE (ALL SUB-GOALS MUST BE COMPLETED):
1. MULTI-STEP / CHAINED INSTRUCTIONS:
   - Carefully read the user's entire prompt for all sequential instructions (e.g. phrases like "and then", "after that", "also change X to Y").
   - Example: "open infinity castle article and then text to standard and color to light".
     Step 1: Navigate to/search for the Infinity Castle article.
     Step 2: Once on the article, locate the Appearance settings menu (or gear/reading preferences icon).
     Step 3: Click 'Standard' font size.
     Step 4: Click 'Light' color mode.
     Step 5: ONLY AFTER ALL steps are completed do you return type="done"!
   - NEVER call type="done" after only the first action if there are remaining steps! Every requested modification or action must be fulfilled!

2. KNOW WHEN TO SAY "DONE" (PREVENT DRIFTING / EXTERNAL NAVIGATION):
   - When ALL requested tasks and sub-goals are 100% fulfilled: STOP IMMEDIATELY and return type="done"!
   - Do NOT continue browsing, do NOT navigate away to Google or external search engines, and do NOT click random unrelated links once the goal is accomplished.
   - Return type="done" with description="Task complete." and final_overview="Done! [2-3 sentence summary of everything accomplished]".

SITE ANCHORING (STAY ON THE REQUESTED WEBSITE):
- If the user specifies a website (e.g. "go to wikipedia and...", "on amazon...", "on youtube...", "on github..."):
  - You MUST stay on that website throughout the task.
  - NEVER navigate away to Google or another search engine once you are already on the user's requested site.
  - Complete the task directly using that site's own search bar, navigation, and links.

CRITICAL AUTONOMY DIRECTIVE:
- BE DECISIVE AND AUTONOMOUS. Do NOT ask the user for permission, confirmation, or choices during standard browsing!
- NEVER ask the user if you should scroll, search, click, navigate, or browse. Just do it!
- When multiple products or options match the user's criteria (e.g. searching for a Cosmic Byte mouse under ₹5000), DO NOT stop to ask which one they prefer. Choose the best matching product (e.g. best rated, best seller, or most relevant within budget), click it, and proceed!
- Autonomously add items to cart, select default/required options (like color or delivery if standard), and proceed through the checkout flow.

WHEN TO ASK THE USER (AND ONLY THEN):
ONLY return type="request_user" when human intervention is strictly required and you CANNOT proceed on your own:
1. User Login / Account Sign-in needed (asking user to log in or solve OTP/MFA).
2. CAPTCHA / Bot detection challenge that blocks progress.
3. Sensitive credentials needed (password, CVV, or government ID).
4. Final Order Placement / Payment Confirmation: Right before clicking the final irreversible "Place Your Order" / "Pay Now" button, return type="confirm_purchase" (or "request_user") with a clear summary of the item and total amount to get confirmation.
5. Absolute dead end: The site has zero search results after filtering and scrolling.

FOR ALL OTHER STEPS: TAKE ACTION YOURSELF!
- To click a button, link, tab, or card: return type="click" with ref="eX" matching the exact ref from the Sanitized Semantic HTML.
- To search or fill a text field: return type="type" with ref="eX", the text, and press_enter=true (if submitting).
- To see more results or explore the page: return type="scroll" with direction="down" (or "up") and amount (e.g. 600-800). Do NOT ask before scrolling!
- To go to a website: return type="navigate" with the url.
- When the overall task is 100% finished: return type="done" with description="Task complete." and final_overview="Done! [Write a clear, friendly 2-3 sentence overview of everything you accomplished from start to finish]."
"""


_key_cursor = 0
_key_cursor_lock = threading.Lock()


def get_gemini_api_keys() -> list[str]:
    """Read configured keys without exposing them to logs or responses."""
    configured = [
        os.getenv("GEMINI_API_KEY_1") or os.getenv("GEMINI_API_KEY"),
        os.getenv("GEMINI_API_KEY_2"),
        os.getenv("GEMINI_API_KEY_3"),
    ]
    if not any(configured):
        configured.append(os.getenv("GOOGLE_API_KEY"))
    return list(dict.fromkeys(key for key in configured if key))


def _round_robin_start(key_count: int) -> int:
    global _key_cursor
    with _key_cursor_lock:
        start = _key_cursor % key_count
        _key_cursor = (_key_cursor + 1) % key_count
    return start


def _is_capacity_error(error: Exception) -> bool:
    message = f"{type(error).__name__} {error}".casefold()
    return any(marker in message for marker in (
        "429", "rate limit", "rate-limit", "rate_limit", "ratelimit", "quota",
        "resource exhausted", "resource_exhausted", "too many requests",
        "too_many_requests", "exhausted",
    ))


def _history_context(history: list[dict[str, str]]) -> str:
    if not history:
        return "(no prior task or action history)"
    return "\n".join(
        f"{entry.get('role', 'user')}: {entry.get('content', '')[:2000]}"
        for entry in history[-20:]
    )


def _target_context(target_map: dict[str, Any]) -> str:
    semantic_dom = target_map.get("semantic_dom") or target_map.get("semanticDom")
    if semantic_dom and isinstance(semantic_dom, str) and len(semantic_dom.strip()) > 30:
        return semantic_dom.strip()[:16000]

    targets = target_map.get("targets")
    if isinstance(targets, list) and targets:
        lines: list[str] = []
        for item in targets:
            if not isinstance(item, dict) or not item.get("ref"):
                continue
            snippet = item.get("snippet")
            if snippet:
                lines.append(f"- {snippet}")
            else:
                ref = str(item.get("ref", "")).strip()
                role = str(item.get("role", "")).strip()
                name = str(item.get("name", "")).strip()
                bounds = item.get("bounds") or {}
                bx = bounds.get("x")
                by = bounds.get("y")
                bw = bounds.get("width")
                bh = bounds.get("height")
                pos_str = f" at [{bx},{by} {bw}x{bh}]" if bx is not None and by is not None else ""
                clean_name = json.dumps(name[:100], ensure_ascii=False) if name else '""'
                lines.append(f"- <{role or 'element'} ref=\"{ref}\" name={clean_name}{pos_str} />")
        if lines:
            return "\n".join(lines[:250])

    try:
        encoded = json.dumps(target_map, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        encoded = "{}"
    return encoded[:12000] or "{}"


def build_graph():
    builder = StateGraph(AgentState)
    builder.add_node("decide", decide_next_action)
    builder.add_edge(START, "decide")
    builder.add_edge("decide", END)
    return builder.compile()


def decide_next_action(state: AgentState) -> dict[str, ActionPlan]:
    api_keys = get_gemini_api_keys()
    if not api_keys:
        return {
            "action": ActionPlan(
                type="request_user",
                description="Configure a Gemini API key on the LangGraph server, then resume this run.",
                reason="The screenshot model is not configured.",
            )
        }

    context = f"User task:\n{state['task']}\n\nCurrent tab URL:\n{state.get('tab_url') or 'unknown'}"
    context += f"\n\nSanitized Simplified Semantic HTML (authoritative ref=\"eX\"):\n{_target_context(state.get('target_map', {}))}"
    context += f"\n\nViewport metadata:\n{json.dumps(state.get('viewport', {}), separators=(',', ':'))}"
    context += f"\n\nTask and action history:\n{_history_context(state.get('history', []))}"
    if state.get("previous_action"):
        context += f"\n\nPrevious action:\n{state['previous_action']}"
    if state.get("observation_unchanged") and state.get("previous_action"):
        streak = state.get("unchanged_streak", 1)
        context += (
            f"\n\n⚠️ PREVIOUS ACTION FAILED / HAD NO EFFECT:\n"
            f"Your previous action was: {state['previous_action']}\n"
            f"NOTICE: The page DID NOT change after executing this action (observation unchanged for {streak} step(s)). "
            f"The element state did not update!\n"
            f"CRITICAL: DO NOT repeat the exact same click on the same element ref!\n"
            f"Instead, try:\n"
            f"1. If clicking a label or option failed, click the parent container, the child span, or the associated input ref.\n"
            f"2. Use coordinate fallback: specify x and y normalized coordinates (0..1000) directly on the center of the target in the screenshot.\n"
            f"3. If an overlay or menu must be opened first, open it.\n"
            f"4. If stuck after attempting an alternative, return type='request_user' to explain the blocker and ask for human assistance."
        )
    if state.get("recent_actions"):
        context += "\n\nRecent normalized actions:\n" + "\n".join(state["recent_actions"][-8:])

    screenshot_url = _normalize_screenshot(state.get("screenshot"))

    start = _round_robin_start(len(api_keys))
    last_error: Exception | None = None
    for offset in range(len(api_keys)):
        api_key = api_keys[(start + offset) % len(api_keys)]
        model = ChatGoogleGenerativeAI(
            model=os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite"),
            google_api_key=api_key,
            temperature=0,
            max_retries=2,
            timeout=45,
        ).with_structured_output(ActionPlan)
        try:
            response = model.invoke(
                [
                    SystemMessage(content=SYSTEM_PROMPT),
                    HumanMessage(
                        content=[
                            {"type": "text", "text": context},
                            {"type": "image_url", "image_url": {"url": screenshot_url}},
                        ]
                    ),
                ]
            )
            if response is not None:
                return {"action": response}
        except Exception as error:
            logger.warning("Gemini API call failed with key %d/%d: %s", offset + 1, len(api_keys), error)
            last_error = error
            continue

    error_detail = str(last_error)[:200] if last_error else "Rate limit or quota reached."
    return {
        "action": ActionPlan(
            type="request_user",
            description="The planner encountered an issue contacting Gemini. Please wait a moment, then tell me to continue.",
            reason=error_detail,
        )
    }
