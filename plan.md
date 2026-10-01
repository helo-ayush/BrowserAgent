# AgentBrow implementation plan

## Product goal

Build a browser extension that works beside the user, visibly operates the current tab, and turns a natural-language task into a sequence of browser actions. The first version optimizes for a working end-to-end loop and uses screenshots on every iteration. Privacy and token efficiency are later optimization layers, not prerequisites for the MVP.

## Milestone 0 — working screenshot-first vertical slice (now)

### Deliverables

- Chrome Manifest V3 extension with a React side panel.
- Task input, live screenshot, action timeline, stop button, and approval card.
- MV3 service worker that binds a run to one tab and loops:
  1. capture the visible tab;
  2. send task + screenshot to the LangGraph server;
  3. receive one typed action;
  4. ask for approval when the action is irreversible;
  5. execute the action in the active page;
  6. capture again and verify through the next graph step.
- Content script for coordinate click, safe text entry, scroll, and visual cursor feedback.
- FastAPI server with a LangGraph `StateGraph` and Gemini 3.1 Flash-Lite vision model.
- Shared JSON action contract and an explicit action allowlist.

### Definition of done

The user can load the unpacked extension, open a shopping site, enter a task such as “find a Cosmic Byte mouse under ₹5000”, and watch the extension navigate/search/select. The agent pauses before placing an order instead of silently committing a purchase.

## Milestone 1 — reliable controlled interaction

- Add run persistence in `chrome.storage.session` so MV3 worker suspension can resume.
- Add signed, expiring action envelopes with sequence numbers and idempotency keys.
- Reject stale screenshots and stale tab/frame/origin bindings.
- Add bounded retries, cancellation, reconnect, and a run event stream.
- Add deterministic coordinate checks and origin-specific permission prompts.
- Add fixtures for Amazon-like search, product cards, carts, and checkout pages.

## Milestone 2 — approval and transaction safety

- Represent approval requests as structured data: merchant, item, quantity, subtotal, shipping, tax, total, currency, and recurring terms.
- Require a fresh screenshot immediately before approval.
- Invalidate approval when merchant, amount, destination, or target changes.
- Never automate passwords, CAPTCHA, MFA, 3DS, biometric prompts, or payment-manager unlocks.
- Add “user takeover” mode so the user can complete sensitive steps, then return control to the agent.
- Verify order success from a fresh page observation; never infer success from a click receipt.

## Milestone 3 — DOM-first token optimization

The DOM path is an optimization hint, not a replacement for visual verification.

### Sanitization pipeline

1. Clone the document in the content script; never serialize the live document directly.
2. Remove non-content nodes: `script`, `style`, `noscript`, `template`, `svg` paths, `canvas`, `iframe`, `object`, `embed`, and shadow roots unless an explicit adapter allows them.
3. Remove hidden/inert nodes using computed visibility, `display:none`, `visibility:hidden`, zero-size clipping, `aria-hidden`, `hidden`, `inert`, and offscreen-only containers.
4. Keep a small semantic allowlist of tags and attributes: landmarks, headings, buttons, links, inputs, labels, lists, tables, and visible text. Drop classes, styles, event handlers, data attributes, tracking IDs, and long opaque IDs.
5. Normalize whitespace, collapse repeated wrappers, cap text length per node, deduplicate repeated product cards, and preserve DOM order.
6. Add stable local node references (not CSS selectors copied to the model) mapped to an in-memory element table in the content script.
7. Extract only task-relevant metadata: role, accessible name, label, state, value shape, bounds, and short visible text.
8. Enforce byte/token budgets at every stage; prefer truncating low-scoring siblings over truncating the task-relevant subtree.
9. Run the future PII detector over text/accessible names before transport. Replace matches with typed placeholders such as `[EMAIL]`, `[PHONE]`, and `[PERSON]`; do not send the original text.
10. Keep a screenshot fallback flag. If the model or a lightweight context classifier says the sanitized representation cannot disambiguate the next action, request a screenshot for that iteration only.

### Training the DOM-vs-screenshot classifier

- Start with a labeled fixture set of `(task, sanitized DOM, screenshot, correct action)`.
- Label `DOM_SUFFICIENT` only when a deterministic evaluator can identify the target and action without pixels; otherwise label `SCREENSHOT_REQUIRED`.
- Train a small local classifier first (text/DOM embeddings + action metadata), not a second VLM.
- Measure false `DOM_SUFFICIENT` decisions more harshly than false screenshot decisions; missing visual context is a correctness failure.
- Add hard negatives: color/position, canvas charts, icons, overlapping elements, carousels, visual disabled states, and anti-bot challenges.
- Keep a confidence threshold and sample uncertain cases for human labeling.

## Milestone 4 — privacy architecture

- Keep screenshot capture and OCR/redaction local whenever possible.
- Integrate the existing VISTA pipeline behind a local privacy adapter; do not block the MVP on it.
- Blur faces and mask PII text regions before any remote model call.
- Apply the same PII pipeline to sanitized DOM text and accessibility names.
- Exclude password, payment, government-ID, and secret inputs by type, autocomplete, label, and nearby context.
- Make redaction visible in the side panel and provide a per-origin privacy mode.
- Store only redacted traces with short retention; never log raw screenshots, raw DOM, credentials, or tokens.

## Milestone 5 — production hardening

- Provider abstraction and model routing (fast planner, fallback VLM, local models).
- Per-origin adapters for difficult sites instead of prompt-only behavior.
- Observability with redacted structured events, latency, action success, screenshot bytes, and token usage.
- Replayable, deterministic browser fixtures in CI.
- Threat model, extension permission review, CSP, dependency scanning, and signed releases.

## Non-negotiable boundaries

- The server proposes; the extension executes.
- No arbitrary JavaScript from the model.
- No background or hidden-tab actions.
- No silent purchase, message send, account change, deletion, or subscription.
- User input wins immediately via stop/takeover.
- Every action is visible in the timeline and linked to a fresh observation.
