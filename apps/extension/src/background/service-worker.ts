import type { Action, RunEvent, WorkerMessage, WorkerState } from "../protocol";

const SERVER_URL = "http://localhost:8787";
let running = false;
let paused = false;
let pageLocked = false;
type BrowserAction = Action & {
  ref?: string;
  target_hint?: string;
  coordinate_space?: "normalized_1000";
  viewport_revision?: number;
  fallback?: boolean;
  coordinateSpace?: "normalized" | "css" | "device-pixels";
  viewportRevision?: number;
};

type TargetMap = Record<string, unknown>;
type ViewportMetadata = {
  width: number;
  height: number;
  device_pixel_ratio: number;
  revision: number;
};
type Observation = {
  screenshot: string;
  target_map: TargetMap;
  viewport: ViewportMetadata;
};

class StaleTargetError extends Error {
  constructor(message = "The browser target changed before execution.") {
    super(message);
    this.name = "StaleTargetError";
  }
}

let pendingApproval: BrowserAction | null = null;
let activeRunId: string | null = null;
let activeTabId: number | null = null;
let runTask = "";
let pauseResolvers: Array<() => void> = [];

const STATE_STORAGE_KEY = "VISTA_WORKER_STATE";

async function persistState() {
  const state = {
    running,
    paused,
    pageLocked,
    pendingApproval,
    activeRunId,
    activeTabId,
    runTask,
  };
  try {
    if (chrome.storage?.session) {
      await chrome.storage.session.set({ [STATE_STORAGE_KEY]: state });
    } else {
      await chrome.storage.local.set({ [STATE_STORAGE_KEY]: state });
    }
  } catch (err) {
    console.error("Failed to persist state:", err);
  }
}

async function restoreState(): Promise<void> {
  try {
    let stored: Record<string, unknown> | undefined;
    if (chrome.storage?.session) {
      stored = await chrome.storage.session.get(STATE_STORAGE_KEY);
    }
    if (!stored || !stored[STATE_STORAGE_KEY]) {
      stored = await chrome.storage.local.get(STATE_STORAGE_KEY);
    }
    const state = stored?.[STATE_STORAGE_KEY] as {
      running?: boolean;
      paused?: boolean;
      pageLocked?: boolean;
      pendingApproval?: BrowserAction | null;
      activeRunId?: string | null;
      activeTabId?: number | null;
      runTask?: string;
    } | undefined;

    if (state) {
      running = Boolean(state.running);
      paused = Boolean(state.paused);
      pageLocked = Boolean(state.pageLocked);
      pendingApproval = state.pendingApproval ?? null;
      activeRunId = state.activeRunId ?? null;
      activeTabId = state.activeTabId ?? null;
      runTask = state.runTask ?? "";
    }
  } catch (err) {
    console.error("Failed to restore state:", err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onMessage.addListener((message: WorkerMessage, _sender, sendResponse) => {
  void (async () => {
    await restoreState();
    return handleMessage(message);
  })().then(sendResponse);
  return true;
});

async function handleMessage(message: WorkerMessage): Promise<RunEvent | WorkerState> {
  if (message.type === "START_RUN") {
    if (running) return { kind: "error", message: "A run is already active." };
    runTask = message.task;
    activeRunId = null;
    activeTabId = null;
    running = true;
    paused = false;
    pendingApproval = null;
    await persistState();
    void runAgent(message.task);
    return { kind: "status", message: "Run started." };
  }

  if (message.type === "STOP_RUN") {
    await finishRun("Stopped by user.");
    return { kind: "status", message: "Stopped by user.", locked: false };
  }

  if (message.type === "PAUSE_RUN") {
    if (!running) return { kind: "status", message: "No run is active." };
    await setPaused(true);
    return { kind: "status", message: "Paused.", locked: false };
  }

  if (message.type === "RESUME_RUN") {
    if (!running) return { kind: "status", message: "No run is active." };
    await setPaused(false);
    return { kind: "status", message: "Resumed.", locked: pageLocked };
  }

  if (message.type === "APPEND_INSTRUCTION") {
    const instruction = message.instruction.trim();
    if (!instruction) return { kind: "error", message: "The instruction cannot be empty." };

    const tab = await getActiveTab();
    if (!tab.id) return { kind: "error", message: "Could not find an active browser tab." };
    activeTabId = tab.id;

    pendingApproval = null;
    running = true;
    paused = false;
    await persistState();

    if (!activeRunId) {
      runTask = instruction;
      await persistState();
      void runAgent(instruction);
      return { kind: "status", message: "Starting new run with instruction." };
    }

    runTask = `${runTask}\n\nAdditional instruction:\n${instruction}`;
    await persistState();

    try {
      const instructionResponse = await fetch(`${SERVER_URL}/runs/${activeRunId}/instructions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction }),
      });

      if (!instructionResponse.ok) {
        const errorText = await instructionResponse.text();
        // If 404 or 409 (run completed or expired), continue with a fresh run
        if (instructionResponse.status === 404 || instructionResponse.status === 409) {
          activeRunId = null;
          await persistState();
          void runAgent(runTask);
          return { kind: "status", message: "Continuing task with new step." };
        }
        await stopWithError(`Server error: ${errorText}`);
        return { kind: "error", message: errorText };
      }

      broadcast({ kind: "status", message: "Instruction received. Continuing..." });

      // Run resume loop asynchronously so handleMessage does not hang or time out
      void (async () => {
        try {
          await setPageLock(true);
          const currentTab = await getActiveTab();
          if (!currentTab.id) {
            await stopWithError("The active tab disappeared.");
            return;
          }
          const observation = await observe(currentTab);
          const response = await fetch(`${SERVER_URL}/runs/${activeRunId}/resume`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              screenshot: observation.screenshot,
              tab_url: currentTab.url,
              target_map: observation.target_map,
              viewport: observation.viewport,
              viewport_revision: observation.viewport.revision,
            }),
          });
          if (!response.ok) {
            const err = await response.text();
            await stopWithError(`Resume failed: ${err}`);
            return;
          }
          const next = (await response.json()) as { action: BrowserAction; screenshot?: string };
          await processAction(next.action, next.screenshot ?? observation.screenshot, currentTab, observation);
        } catch (err) {
          await stopWithError(err instanceof Error ? err.message : "Error resuming run.");
        }
      })();

      return { kind: "status", message: "Instruction added and run resumed.", locked: pageLocked };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to send instruction.";
      await stopWithError(msg);
      return { kind: "error", message: msg };
    }
  }

  if (message.type === "APPROVE_ACTION") {
    const action = pendingApproval;
    pendingApproval = null;
    await persistState();
    if (!action || !running) return { kind: "status", message: "No approval pending." };
    await setPageLock(true);
    void executeAction(action);
    return { kind: "status", message: "Approved. Continuing.", locked: true };
  }

  if (message.type === "REJECT_ACTION") {
    await finishRun("Action rejected. Run stopped.");
    return { kind: "status", message: "Rejected.", locked: false };
  }

  return { running, paused, locked: pageLocked };
}

async function runAgent(task: string) {
  pendingApproval = null;
  let tab = await getActiveTab();
  if (!tab.id) return stopWithError("Could not find an active tab.");
  tab = await ensureCapturableTab(tab, task);
  if (!tab.id) return stopWithError("Could not find an active tab.");
  activeTabId = tab.id;
  await persistState();
  broadcast({ kind: "status", message: `Watching ${new URL(tab.url ?? "https://unknown").hostname}` });
  await setPageLock(true);

  try {
    const first = await observe(tab);
    const response = await fetch(`${SERVER_URL}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task,
        screenshot: first.screenshot,
        tab_url: tab.url,
        target_map: first.target_map,
        viewport: first.viewport,
        viewport_revision: first.viewport.revision,
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    const started = (await response.json()) as { run_id: string; action: BrowserAction; screenshot?: string };
    activeRunId = started.run_id;
    await persistState();
    await processAction(started.action, started.screenshot ?? first.screenshot, tab, first);
  } catch (error) {
    await stopWithError(error instanceof Error ? error.message : "Unknown server error.");
  }
}

async function processAction(action: BrowserAction, screenshot: string, tab: chrome.tabs.Tab, observation?: Observation) {
  await waitForResume();
  if (!running) return;

  if (action.type === "done") {
    const overview =
      (typeof action.final_overview === "string" && action.final_overview.trim()) ||
      (typeof action.summary === "string" && action.summary.trim()) ||
      (typeof action.description === "string" && action.description.trim()) ||
      "Done! The task has been completed.";
    await finishRun(overview, "done");
    return;
  }

  broadcast({ kind: "action", message: action.description, action, screenshot });

  if (action.type === "confirm_purchase" || action.type === "request_user") {
    pendingApproval = action;
    await persistState();
    await setPageLock(false);
    broadcast({ kind: "approval", message: action.description, action, screenshot, locked: false });
    return;
  }

  await executeAction(action, tab, observation ? { target_map: observation.target_map, viewport: observation.viewport } : undefined);
}

async function executeAction(action: BrowserAction, tab?: chrome.tabs.Tab, context?: Omit<Observation, "screenshot">) {
  await waitForResume();
  if (!running || !activeRunId) return;
  const current = tab ?? (await getActiveTab());
  if (!current.id) return stopWithError("The active tab disappeared.");
  activeTabId = current.id;

  try {
    const currentContext = context ?? await requestTargetContext(current);
    if (action.type === "navigate") {
      await chrome.tabs.update(current.id, { url: action.url });
      await waitForTabReady(current.id);
      // Navigation replaces the content script, so synchronize the lock with
      // the new document after it has had time to load.
      await setPageLock(true, current.id);
    } else if (action.type === "wait") {
      await sleep(Math.min(action.milliseconds, 5000));
    } else if (action.type === "confirm_purchase") {
      assertActionTargetIsCurrent(action, currentContext);
      const executionAction = toExecutionAction(action, currentContext.viewport);
      const purchaseCoordinates = executionAction as BrowserAction & { x?: number; y?: number };
      if (purchaseCoordinates.x === undefined && !executionAction.ref) {
        throw new Error("The approved purchase action has no safe click target.");
      }
      const result = await chrome.tabs.sendMessage(current.id, {
        type: "EXECUTE_ACTION",
        action: { ...executionAction, type: "click", description: "Approved purchase click" },
        target_map: currentContext.target_map,
        viewport: currentContext.viewport,
        viewport_revision: currentContext.viewport.revision,
      }) as { ok?: boolean; reason?: string } | undefined;
      if (isStaleTargetResult(result)) throw new StaleTargetError(result?.reason);
      if (result?.ok === false) throw new Error(result.reason || "The page rejected the action.");
      await sleep(450);
    } else if (action.type !== "request_user") {
      assertActionTargetIsCurrent(action, currentContext);
      const executionAction = toExecutionAction(action, currentContext.viewport);
      const result = await chrome.tabs.sendMessage(current.id, {
        type: "EXECUTE_ACTION",
        action: executionAction,
        target_map: currentContext.target_map,
        viewport: currentContext.viewport,
        viewport_revision: currentContext.viewport.revision,
      }) as { ok?: boolean; reason?: string } | undefined;
      if (isStaleTargetResult(result)) throw new StaleTargetError(result?.reason);
      if (result?.ok === false) throw new Error(result.reason || "The page rejected the action.");
      await sleep(450);
    }

    await waitForResume();
    if (!running || !activeRunId) return;
    const freshTab = await chrome.tabs.get(current.id);
    const observation = await observe(freshTab);
    const next = await requestStep(freshTab, observation);
    await processAction(next.action, next.screenshot ?? observation.screenshot, freshTab, next.observation);
  } catch (error) {
    if (error instanceof StaleTargetError && running && activeRunId) {
      try {
        // Never retry a stale ref against its old map. Ask the planner again.
        const freshTab = await chrome.tabs.get(current.id);
        const observation = await observe(freshTab);
        const next = await requestStep(freshTab, observation);
        await processAction(next.action, next.screenshot ?? observation.screenshot, freshTab, observation);
      } catch (refreshError) {
        if (running) await stopWithError(refreshError instanceof Error ? refreshError.message : "Could not refresh the browser target.");
      }
      return;
    }
    if (running) await stopWithError(error instanceof Error ? error.message : "Could not execute action.");
  }
}

async function requestStep(tab: chrome.tabs.Tab, observation: Observation) {
  if (!activeRunId) throw new Error("The run is no longer active.");
  const response = await fetch(`${SERVER_URL}/runs/${activeRunId}/step`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      screenshot: observation.screenshot,
      tab_url: tab.url,
      target_map: observation.target_map,
      viewport: observation.viewport,
      viewport_revision: observation.viewport.revision,
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  return { ...(await response.json()) as { action: BrowserAction; screenshot?: string }, observation };
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  if (activeTabId !== null) {
    try {
      const tab = await chrome.tabs.get(activeTabId);
      if (tab && tab.id) return tab;
    } catch {
      // Tab closed or not found
    }
  }
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs[0]?.id) {
    activeTabId = tabs[0].id;
    return tabs[0];
  }
  const anyActive = await chrome.tabs.query({ active: true });
  if (anyActive[0]?.id) {
    activeTabId = anyActive[0].id;
    return anyActive[0];
  }
  return tabs[0] ?? {};
}

async function ensureCapturableTab(tab: chrome.tabs.Tab, task: string) {
  if (tab.url?.startsWith("http://") || tab.url?.startsWith("https://")) return tab;

  const explicitUrl = task.match(/https?:\/\/[^\s"'<>]+/i)?.[0]?.replace(/[),.;]+$/, "");
  const destination = explicitUrl && isHttpUrl(explicitUrl) ? explicitUrl : "https://www.google.com";
  broadcast({ kind: "status", message: "Opening a web page before observing." });
  await chrome.tabs.update(tab.id!, { url: destination });
  await waitForTabReady(tab.id!);
  return chrome.tabs.get(tab.id!);
}

async function capture(windowId?: number) {
  if (windowId === undefined) throw new Error("No browser window available.");
  return chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 72 });
}

async function observe(tab: chrome.tabs.Tab): Promise<Observation> {
  const context = await requestTargetContext(tab);
  return { ...context, screenshot: await capture(tab.windowId) };
}

async function requestTargetContext(tab: chrome.tabs.Tab): Promise<Omit<Observation, "screenshot">> {
  const fallback: Omit<Observation, "screenshot"> = {
    target_map: {},
    viewport: { width: 1000, height: 1000, device_pixel_ratio: 1, revision: 0 },
  };
  if (!tab.id) return fallback;
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: "GET_TARGET_MAP" }) as {
      target_map?: TargetMap;
      targetMap?: TargetMap;
      targets?: unknown[];
      viewport?: Partial<ViewportMetadata> & { devicePixelRatio?: number };
      viewport_revision?: number;
      viewportRevision?: number;
    } | undefined;
    const viewport = result?.viewport;
    return {
      target_map: result?.target_map ?? result?.targetMap ?? (result?.targets ? { targets: result.targets } : {}),
      viewport: {
        width: positiveNumber(viewport?.width, fallback.viewport.width),
        height: positiveNumber(viewport?.height, fallback.viewport.height),
        device_pixel_ratio: positiveNumber(viewport?.device_pixel_ratio ?? viewport?.devicePixelRatio, fallback.viewport.device_pixel_ratio),
        revision: nonNegativeNumber(viewport?.revision ?? result?.viewport_revision ?? result?.viewportRevision, fallback.viewport.revision),
      },
    };
  } catch {
    // Keep the screenshot fallback usable with older content scripts while
    // still requesting a map before every observation and action.
    return fallback;
  }
}

function assertActionTargetIsCurrent(action: BrowserAction, observation: Omit<Observation, "screenshot">) {
  if (action.viewport_revision !== undefined && action.viewport_revision !== observation.viewport.revision) {
    throw new StaleTargetError("The viewport revision no longer matches the action.");
  }
  if (action.ref && !targetMapHasRef(observation.target_map, action.ref)) {
    throw new StaleTargetError("The requested target ref is no longer present.");
  }
}

function targetMapHasRef(targetMap: TargetMap, ref: string) {
  if (Object.prototype.hasOwnProperty.call(targetMap, ref)) return true;
  const refs = targetMap.refs;
  if (refs && typeof refs === "object" && !Array.isArray(refs)) {
    return Object.prototype.hasOwnProperty.call(refs, ref);
  }
  const targets = targetMap.targets;
  return Array.isArray(targets) && targets.some((target) => Boolean(target && typeof target === "object" && (target as { ref?: string }).ref === ref));
}

function toExecutionAction(action: BrowserAction, viewport: ViewportMetadata): BrowserAction {
  const coordinates = action as BrowserAction & { x?: number; y?: number };
  const coordinateSpace = action.coordinate_space ?? (action.coordinateSpace === "normalized" ? "normalized_1000" : action.coordinateSpace);
  const targetRevision = action.viewport_revision ?? action.viewportRevision ?? viewport.revision;
  if (coordinates.x === undefined || coordinates.y === undefined || coordinateSpace !== "normalized_1000") {
    return { ...action, viewportRevision: targetRevision } as BrowserAction;
  }
  return {
    ...action,
    x: Math.round((coordinates.x / 1000) * viewport.width),
    y: Math.round((coordinates.y / 1000) * viewport.height),
    coordinate_space: undefined,
    coordinateSpace: "css",
    viewportRevision: targetRevision,
  } as BrowserAction;
}

function isStaleTargetResult(result: { ok?: boolean; reason?: string; error?: { code?: string; message?: string } } | undefined) {
  if (!result) return false;
  return result.ok === false && /(stale|mismatch|viewport|target)/i.test(`${result.reason ?? ""} ${result.error?.code ?? ""} ${result.error?.message ?? ""}`);
}

function positiveNumber(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function setPageLock(locked: boolean, tabId = activeTabId) {
  pageLocked = locked && running && !pendingApproval && !paused;
  if (tabId !== null) {
    await chrome.tabs.sendMessage(tabId, { type: "SET_PAGE_LOCK", locked: pageLocked }).catch(() => undefined);
  }
  await persistState();
  broadcast({ kind: "status", message: "", locked: pageLocked });
}

async function setPaused(next: boolean) {
  paused = next;
  if (next) {
    await setPageLock(false);
  } else {
    resolvePausedWaiters();
    if (running && !pendingApproval) await setPageLock(true);
  }
  await persistState();
}

function waitForResume() {
  if (!running || !paused) return Promise.resolve();
  return new Promise<void>((resolve) => pauseResolvers.push(resolve));
}

function resolvePausedWaiters() {
  const waiters = pauseResolvers;
  pauseResolvers = [];
  waiters.forEach((resolve) => resolve());
}

async function finishRun(message: string, kind: "done" | "status" = "status") {
  const wasActive = running || pageLocked;
  running = false;
  paused = false;
  pendingApproval = null;
  activeRunId = null;
  await persistState();
  resolvePausedWaiters();
  await setPageLock(false);
  if (wasActive) broadcast({ kind, message, locked: false });
}

async function stopWithError(message: string) {
  running = false;
  paused = false;
  pendingApproval = null;
  activeRunId = null;
  await persistState();
  resolvePausedWaiters();
  await setPageLock(false);
  broadcast({ kind: "error", message, locked: false });
}

function broadcast(event: RunEvent) {
  void chrome.runtime.sendMessage({ type: "RUN_EVENT", event }).catch(() => undefined);
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTabReady(tabId: number, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") {
        await sleep(500);
        return;
      }
    } catch {
      // Tab may be loading or temporarily unavailable
    }
    await sleep(200);
  }
}
