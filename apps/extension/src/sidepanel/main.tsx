import React, { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUp,
  ChevronDown,
  CircleStop,
  Eye,
  History,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type { Action, RunEvent, WorkerMessage } from "../protocol";
import "./styles.css";

export type ChatItem = RunEvent & { id: string; timestamp: number };

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  events: ChatItem[];
  running: boolean;
  paused: boolean;
  approval: Action | null;
  activeRunId?: string | null;
}

const SESSIONS_STORAGE_KEY = "vista_chat_sessions_v1";
const ACTIVE_SESSION_STORAGE_KEY = "vista_active_session_id_v1";

function createNewSession(title = "New task"): ChatSession {
  const now = Date.now();
  return {
    id: `chat_${now}_${Math.random().toString(36).slice(2, 7)}`,
    title,
    createdAt: now,
    updatedAt: now,
    events: [],
    running: false,
    paused: false,
    approval: null,
  };
}

function App() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [draft, setDraft] = useState("");
  const [locked, setLocked] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  const chatBottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load stored sessions
  useEffect(() => {
    void chrome.storage.local.get([SESSIONS_STORAGE_KEY, ACTIVE_SESSION_STORAGE_KEY]).then((stored) => {
      const savedSessions = stored[SESSIONS_STORAGE_KEY] as ChatSession[] | undefined;
      const savedActiveId = stored[ACTIVE_SESSION_STORAGE_KEY] as string | undefined;

      if (savedSessions && savedSessions.length > 0) {
        setSessions(savedSessions);
        const match = savedSessions.find((s) => s.id === savedActiveId);
        setActiveSessionId(match ? match.id : savedSessions[0].id);
      } else {
        const initial = createNewSession();
        setSessions([initial]);
        setActiveSessionId(initial.id);
        persistSessions([initial], initial.id);
      }
    });
  }, []);

  // Sync worker state
  useEffect(() => {
    void chrome.runtime.sendMessage({ type: "GET_STATE" }).then((state: { running?: boolean; paused?: boolean; locked?: boolean }) => {
      if (!state) return;
      setLocked(Boolean(state.locked));
      if (typeof state.running === "boolean") {
        setSessions((prev) =>
          prev.map((s) => (s.id === activeSessionId ? { ...s, running: Boolean(state.running), paused: Boolean(state.paused) } : s))
        );
      }
    });
  }, [activeSessionId]);

  // Active session helper
  const currentSession = useMemo(() => {
    return sessions.find((s) => s.id === activeSessionId) || sessions[0] || createNewSession();
  }, [sessions, activeSessionId]);

  const { running, paused, events, approval, title } = currentSession;

  // Runtime event listener
  useEffect(() => {
    const listener = (message: { type?: string; event?: RunEvent }) => {
      if (message.type !== "RUN_EVENT" || !message.event) return;
      const event = message.event;
      const now = Date.now();
      const newEvent: ChatItem = { ...event, id: `${now}-${Math.random().toString(36).slice(2, 6)}`, timestamp: now };

      if (typeof event.locked === "boolean") setLocked(event.locked);

      setSessions((prev) => {
        const next = prev.map((s) => {
          if (s.id !== activeSessionId) return s;

          let nextRunning = s.running;
          let nextPaused = s.paused;
          let nextApproval = s.approval;

          if (event.kind === "approval") {
            nextApproval = event.action ?? null;
            nextRunning = true;
            nextPaused = false;
          }
          if (event.kind === "done" || event.kind === "error" || (event.kind === "status" && /stopped|rejected/i.test(event.message))) {
            nextRunning = false;
            nextPaused = false;
            nextApproval = null;
          }
          if (event.kind === "status" && event.message === "Paused.") nextPaused = true;
          if (event.kind === "status" && event.message === "Resumed.") nextPaused = false;

          const shouldAppend = Boolean(
            event.message?.trim() || event.screenshot || event.action || event.kind === "done"
          );

          return {
            ...s,
            updatedAt: now,
            events: shouldAppend ? [...s.events, newEvent] : s.events,
            running: nextRunning,
            paused: nextPaused,
            approval: nextApproval,
          };
        });

        persistSessions(next, activeSessionId);
        return next;
      });
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [activeSessionId]);

  // Auto-scroll on new messages
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length, approval, running]);

  // Window paste fallback so pasting anywhere in sidepanel lands in composer
  useEffect(() => {
    const handleWindowPaste = (e: ClipboardEvent) => {
      if (document.activeElement !== textareaRef.current && !(document.activeElement instanceof HTMLInputElement)) {
        const text = e.clipboardData?.getData("text");
        if (text && textareaRef.current) {
          e.preventDefault();
          textareaRef.current.focus();
          setDraft((prev) => {
            const nextVal = (prev ? prev + " " : "") + text;
            requestAnimationFrame(() => {
              if (textareaRef.current) {
                textareaRef.current.selectionStart = textareaRef.current.selectionEnd = nextVal.length;
                textareaRef.current.style.height = "auto";
                textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 140)}px`;
              }
            });
            return nextVal;
          });
        }
      }
    };

    window.addEventListener("paste", handleWindowPaste);
    return () => window.removeEventListener("paste", handleWindowPaste);
  }, []);

  const send = (message: WorkerMessage) => chrome.runtime.sendMessage(message);

  const startNewChat = () => {
    const newSession = createNewSession();
    const nextSessions = [newSession, ...sessions];
    setSessions(nextSessions);
    setActiveSessionId(newSession.id);
    setShowHistory(false);
    setDraft("");
    persistSessions(nextSessions, newSession.id);
    setTimeout(() => textareaRef.current?.focus(), 50);
  };

  const switchChat = (id: string) => {
    setActiveSessionId(id);
    setShowHistory(false);
    persistSessions(sessions, id);
    setTimeout(() => textareaRef.current?.focus(), 50);
  };

  const deleteChat = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const remaining = sessions.filter((s) => s.id !== id);
    if (remaining.length === 0) {
      const fresh = createNewSession();
      setSessions([fresh]);
      setActiveSessionId(fresh.id);
      persistSessions([fresh], fresh.id);
    } else {
      setSessions(remaining);
      if (activeSessionId === id) {
        setActiveSessionId(remaining[0].id);
        persistSessions(remaining, remaining[0].id);
      } else {
        persistSessions(remaining, activeSessionId);
      }
    }
  };

  const submit = async (e?: FormEvent | KeyboardEvent) => {
    e?.preventDefault();
    const instruction = draft.trim();
    if (!instruction) return;
    setDraft("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    const now = Date.now();
    const userEvent: ChatItem = {
      id: `${now}-user`,
      kind: "status",
      message: instruction,
      timestamp: now,
    };

    // Auto-title if it's the first prompt and title is default
    const isNew = events.length === 0 || currentSession.title === "New task";
    const sessionTitle = isNew ? generateTitle(instruction) : currentSession.title;

    if (running) {
      setSessions((prev) => {
        const next = prev.map((s) =>
          s.id === activeSessionId
            ? {
                ...s,
                updatedAt: now,
                events: [...s.events, userEvent],
                approval: null,
                paused: false,
              }
            : s
        );
        persistSessions(next, activeSessionId);
        return next;
      });
      const response = await send({ type: "APPEND_INSTRUCTION", instruction }) as RunEvent | undefined;
      if (response && response.kind === "error") {
        setSessions((prev) => {
          const errEvent: ChatItem = {
            id: `${Date.now()}-err`,
            kind: "error",
            message: response.message || "Failed to append instruction.",
            timestamp: Date.now(),
          };
          const next = prev.map((s) =>
            s.id === activeSessionId ? { ...s, events: [...s.events, errEvent], running: false, approval: null } : s
          );
          persistSessions(next, activeSessionId);
          return next;
        });
      }
      return;
    }

    setSessions((prev) => {
      const next = prev.map((s) =>
        s.id === activeSessionId
          ? {
              ...s,
              title: sessionTitle,
              updatedAt: now,
              events: [userEvent],
              running: true,
              paused: false,
              approval: null,
            }
          : s
      );
      persistSessions(next, activeSessionId);
      return next;
    });

    await send({ type: "START_RUN", task: instruction });
  };

  const stop = async () => {
    await send({ type: "STOP_RUN" });
    setSessions((prev) =>
      prev.map((s) => (s.id === activeSessionId ? { ...s, running: false, paused: false, approval: null } : s))
    );
    setLocked(false);
  };

  const togglePause = async () => {
    const next = !paused;
    setSessions((prev) => prev.map((s) => (s.id === activeSessionId ? { ...s, paused: next } : s)));
    await send({ type: next ? "PAUSE_RUN" : "RESUME_RUN" });
  };

  const saveTitle = () => {
    const trimmed = titleDraft.trim();
    if (trimmed) {
      setSessions((prev) => {
        const next = prev.map((s) => (s.id === activeSessionId ? { ...s, title: trimmed } : s));
        persistSessions(next, activeSessionId);
        return next;
      });
    }
    setEditingTitle(false);
  };

  const currentLiveStatus = useMemo(() => {
    if (!running) return "";
    if (paused) return "Paused — waiting for resume or instruction.";
    if (approval) return "Waiting for your reply...";
    const last = events[events.length - 1];
    if (!last) return "Agent is observing the tab...";
    if (last.kind === "action") return `Executing: ${last.message}`;
    return last.message;
  }, [running, paused, approval, events]);

  // Focus input when agent asks something
  useEffect(() => {
    if (approval) {
      setTimeout(() => textareaRef.current?.focus(), 60);
    }
  }, [approval]);

  return (
    <main className="shell dark-theme">
      {/* Top Header without logo (clean, standard style) */}
      <header className="topbar">
        <div className="topbar-left">
          {editingTitle ? (
            <input
              type="text"
              className="title-edit-input"
              value={titleDraft}
              autoFocus
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveTitle();
                if (e.key === "Escape") setEditingTitle(false);
              }}
            />
          ) : (
            <h1
              className="session-title"
              title="Click to rename chat"
              onClick={() => {
                setTitleDraft(title);
                setEditingTitle(true);
              }}
            >
              <span>{title}</span>
              <Pencil size={11} className="title-edit-icon" />
            </h1>
          )}
        </div>

        {/* Top Right Action Icons (History & New Chat) */}
        <div className="topbar-actions">
          <button
            className={`icon-btn ${showHistory ? "active" : ""}`}
            title="Chat History"
            aria-label="Chat History"
            onClick={() => setShowHistory(!showHistory)}
          >
            <History size={16} />
            {sessions.length > 1 && <span className="history-count-dot" />}
          </button>
          <button
            className="icon-btn"
            title="New Chat"
            aria-label="New Chat"
            onClick={startNewChat}
          >
            <Plus size={18} />
          </button>
        </div>
      </header>

      {/* History Slide-over Drawer & Backdrop */}
      {showHistory && (
        <>
          <div className="drawer-backdrop" onClick={() => setShowHistory(false)} />
          <section className="history-drawer" aria-label="Chat history">
            <div className="history-drawer-header">
              <div className="history-drawer-title">
                <MessageSquare size={14} />
                <span>Chats ({sessions.length})</span>
              </div>
              <div className="history-drawer-actions">
                <button className="new-chat-pill-btn" onClick={startNewChat}>
                  <Plus size={13} /> New Chat
                </button>
                <button className="icon-btn-close" onClick={() => setShowHistory(false)}>
                  <X size={15} />
                </button>
              </div>
            </div>

            <div className="history-list">
              {sessions.map((sess) => {
                const isActive = sess.id === activeSessionId;
                const lastEvent = sess.events[sess.events.length - 1];
                return (
                  <div
                    key={sess.id}
                    className={`history-item ${isActive ? "active" : ""}`}
                    onClick={() => switchChat(sess.id)}
                  >
                    <div className="history-item-body">
                      <strong className="history-item-title">{sess.title}</strong>
                      <span className="history-item-preview">
                        {lastEvent ? lastEvent.message : "No actions yet"}
                      </span>
                      <span className="history-item-time">{formatRelativeTime(sess.updatedAt)}</span>
                    </div>
                    <button
                      className="history-delete-btn"
                      title="Delete chat"
                      onClick={(e) => deleteChat(sess.id, e)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}

      {/* Live Status Bar */}
      {running && currentLiveStatus && (
        <section className="live-status-bar" role="status" aria-live="polite">
          <span className="live-status-pulse" />
          <div className="live-status-content">
            <span className="live-status-label">{paused ? "PAUSED" : approval ? "AWAITING REPLY" : "ACTIVE TASK"}</span>
            <span className="live-status-text">{currentLiveStatus}</span>
          </div>
        </section>
      )}

      {/* Welcome Screen when Empty (clean, no big badge) */}
      {events.length === 0 && (
        <section className="welcome-empty">
          <h2>What can I help you browse?</h2>
          <p>Give me any task. I’ll navigate, inspect, and take visible actions directly inside your active tab.</p>
        </section>
      )}

      {/* Conversation Stream */}
      <section className="conversation" aria-label="Conversation">
        {events.map((event) => {
          const isUser = event.id.endsWith("-user");
          const isObservation = Boolean(event.screenshot);

          if (isUser) {
            return (
              <article className="message user-message" key={event.id}>
                <div className="user-bubble">{event.message}</div>
              </article>
            );
          }

          // Skip empty status bubbles
          if (!event.message?.trim() && !event.screenshot && !event.action && event.kind !== "done") {
            return null;
          }

          // Structured action / status / done layout
          const label =
            event.kind === "action"
              ? event.action?.type?.toUpperCase() || "ACTION"
              : event.kind === "approval"
              ? event.action?.type === "confirm_purchase"
                ? "CONFIRMATION"
                : "AGENT QUESTION"
              : event.kind === "done"
              ? "DONE"
              : event.kind === "error"
              ? "ERROR"
              : "STATUS";

          return (
            <article className={`message agent-message ${event.kind}`} key={event.id}>
              <div className="message-grid">
                <div className="message-col-label">
                  <span className={`kind-tag ${event.kind}`}>{label}</span>
                </div>
                <div className="message-col-content">
                  <p className="message-text">{event.message}</p>

                  {/* Ref details if available */}
                  {event.action && "ref" in event.action && Boolean(event.action.ref) && (
                    <div className="target-badge">
                      Target ref: <code>{(event.action as { ref?: string }).ref}</code>
                    </div>
                  )}

                  {/* Purchase summary if provided */}
                  {event.action?.type === "confirm_purchase" && event.action.summary && (
                    <div className="purchase-summary-box">
                      <span>{event.action.summary.item ?? "Item"}</span>
                      <b>{event.action.summary.total ?? ""}</b>
                    </div>
                  )}

                  {/* Collapsible observation screenshot */}
                  {isObservation && (
                    <details className="observation-dropdown">
                      <summary>
                        <Eye size={13} />
                        <span>View observation screenshot</span>
                        <ChevronDown size={13} className="obs-chevron" />
                      </summary>
                      <div className="obs-image-wrap">
                        <img src={event.screenshot} alt="Page observation" />
                      </div>
                    </details>
                  )}
                </div>
              </div>
            </article>
          );
        })}
        <div ref={chatBottomRef} />
      </section>

      {/* Run Controls floating above composer */}
      {running && (
        <div className="floating-run-bar">
          <button className="run-btn pause" onClick={() => void togglePause()}>
            {paused ? <Play size={13} /> : <Pause size={13} />}
            <span>{paused ? "Resume" : "Pause"}</span>
          </button>
          <button className="run-btn stop" onClick={() => void stop()}>
            <CircleStop size={13} />
            <span>Stop</span>
          </button>
          {locked && <span className="lock-indicator">🔒 Page locked</span>}
        </div>
      )}

      {/* Ultra-Clean Floating Bottom Composer (no chip, no plus, no flash) */}
      <form
        className="composer-container"
        onSubmit={submit}
        onClick={() => textareaRef.current?.focus()}
      >
        <div
          className="composer-main-row"
          onClick={() => textareaRef.current?.focus()}
        >
          <textarea
            ref={textareaRef}
            value={draft}
            rows={1}
            onChange={(e) => {
              setDraft(e.target.value);
              // auto resize textarea
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
            }}
            onPaste={(e) => {
              const text = e.clipboardData?.getData("text");
              if (!text) return;
              e.preventDefault();
              const target = e.currentTarget;
              const start = target.selectionStart ?? draft.length;
              const end = target.selectionEnd ?? draft.length;
              const nextVal = draft.slice(0, start) + text + draft.slice(end);
              setDraft(nextVal);
              requestAnimationFrame(() => {
                if (textareaRef.current) {
                  textareaRef.current.selectionStart = textareaRef.current.selectionEnd = start + text.length;
                  textareaRef.current.style.height = "auto";
                  textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 140)}px`;
                }
              });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit(e);
              }
            }}
            placeholder={
              approval
                ? "Reply to the agent or give instructions..."
                : running
                ? "Add an instruction to this run..."
                : "Assign a task or type an instruction..."
            }
            aria-label="Task or instruction"
          />

          <button
            className="composer-send-btn"
            type="submit"
            disabled={!draft.trim()}
            aria-label="Send instruction"
          >
            <ArrowUp size={16} />
          </button>
        </div>
      </form>
    </main>
  );
}

function generateTitle(prompt: string): string {
  const clean = prompt.replace(/\s+/g, " ").trim();
  if (clean.length <= 36) return clean;
  return `${clean.slice(0, 34)}…`;
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function persistSessions(sessions: ChatSession[], activeId: string) {
  const sanitized = sessions.map((sess) => {
    let obsCount = 0;
    const events = sess.events
      .slice()
      .reverse()
      .map((ev) => {
        if (ev.screenshot) {
          obsCount += 1;
          if (obsCount > 6) {
            return { ...ev, screenshot: undefined };
          }
        }
        return ev;
      })
      .reverse();

    return { ...sess, events };
  });

  void chrome.storage.local.set({
    [SESSIONS_STORAGE_KEY]: sanitized,
    [ACTIVE_SESSION_STORAGE_KEY]: activeId,
  });
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
