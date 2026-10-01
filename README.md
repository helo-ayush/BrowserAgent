# AgentBrow

AgentBrow is a user-visible Chrome side-panel agent. It receives a natural-language task, observes the active tab with screenshots, asks a LangGraph server for the next typed action, executes only that action in the page, and repeats until it finishes or needs the user.

This first milestone is intentionally **screenshot-first**. It does not send DOM HTML to the model yet. The future DOM/privacy work is captured in `plan.md`.

## Current architecture

```text
Chrome side panel (React)
        │ messages
MV3 service worker ── screenshot + local target map + typed action execution ── content script
        │ HTTP
FastAPI + LangGraph + Gemini 3.1 Flash-Lite
```

The extension is the only component allowed to operate the page. The server only proposes a typed action. Checkout, payment, account changes, and order placement are approval-gated.

Each observation asks the active tab for its local target map and viewport
revision. The planner prefers those stable refs; normalized 0..1000
coordinates remain an explicit screenshot fallback. If a target or viewport
becomes stale before execution, the worker takes a fresh observation and asks
for a new action instead of clicking the old target.

## Quick start

### 1. Start the LangGraph server

```powershell
cd apps/server
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:GEMINI_API_KEY_1 = "paste-your-first-key-locally"
$env:GEMINI_API_KEY_2 = "optional-second-key-locally"
$env:GEMINI_API_KEY_3 = "optional-third-key-locally"
$env:GEMINI_MODEL = "gemini-3.1-flash-lite"
uvicorn app.main:app --reload --port 8787
```

The server reads `GEMINI_API_KEY_1`, `GEMINI_API_KEY_2`, and `GEMINI_API_KEY_3` (`GEMINI_API_KEY` is accepted as key 1, and `GOOGLE_API_KEY` remains a compatibility fallback). Keys are selected round-robin across the process and quota/rate-limit failures fall back to the next configured key. Keep keys in your local shell or an ignored `.env` file; do not commit them. Gemini 3.1 Flash-Lite receives the current screenshot and returns one structured browser action per iteration.

Optional local `.env` file in `apps/server/.env`:

```dotenv
GEMINI_API_KEY_1=your-key-here
GEMINI_API_KEY_2=
GEMINI_API_KEY_3=
GEMINI_MODEL=gemini-3.1-flash-lite
```

Runs retain task/action history while active. A client can append a takeover
instruction with `POST /runs/{run_id}/instructions`, then request a fresh action
with `POST /runs/{run_id}/resume` (or `/next`) and a new screenshot.

In the extension, the side panel behaves like a chat: submit the first task,
then send follow-up instructions in the same composer without losing the
conversation. **Pause** stops the loop at its next action boundary, **Stop**
ends the run, and the page receives a blue lock overlay while the agent is
working. Every observation is retained in the chat as a collapsed “View
observation” item. If the same action/page state repeats three times, the
server pauses and asks the user to take over rather than looping forever.

The implementation deliberately makes one Gemini request per browser action. With a free rate limit around 15 requests/minute, keep early tasks short and stop/restart runs when experimenting.

### 2. Build the extension

```powershell
npm install
npm run build:extension
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `apps/extension/dist`.

For development with hot rebuilds:

```powershell
npm run dev:extension
```

Load `apps/extension/dist` once and reload the extension after changes.

## Safety note

This is an early engineering scaffold, not a production purchasing bot. Never add payment credentials to prompts or logs. The final purchase step is deliberately stopped for explicit approval in the side panel; CAPTCHA, MFA, passwords, and payment verification are handed back to the user.

See `plan.md` for the milestone plan and future sanitized-DOM/PII design.
